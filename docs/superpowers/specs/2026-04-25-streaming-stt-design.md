# Streaming STT — design

Streaming PCM в `gpt-4o-transcribe` через OpenAI Realtime API в режиме
transcription-only вместо текущего «собрать WAV → POST → дождаться
полного текста». Цель: latency «конец речи → первый звук ответа»
падает на 300-1000 мс на каждой команде, потому что модели остаётся
декодировать только хвост после тишины.

Источник: [docs/superpowers/roadmap.md](../roadmap.md), раздел «Голос и
аудио → Streaming STT».

## Скоп

**В скопе:**

- Новый `OpenAiStt.startSession()` — открывает Realtime WS, принимает
  фреймы PCM по мере прихода, на `finalize()` коммитит и возвращает
  финальный транскрипт.
- Локальная буферизация фреймов на время WS handshake (см. ниже).
- Перевод [src/orchestrator/orchestrator.ts](../../../src/orchestrator/orchestrator.ts)
  на streaming-сессию: открытие на `startCapture`, push фреймов в
  `mic.onFrame`, `finalize` на `endCapture`, `abort` при barge-in
  во время capture.
- Сохраняем `OpenAiStt.transcribe(buf)` для тестов и `voice.ts`
  (push-to-talk) — внутри реализуем через ту же сессию.
- Тесты: unit на `OpenAiStt` с моком `ws`; unit на orchestrator с
  фейковой сессией; integration (RUN_INTEGRATION=1) с живым API.

**Вне скопа:**

- Переезд `voice.ts` на streaming-сессию (push-to-talk — dev-инструмент,
  оставляем на `transcribe(buf)` поверх новой сессии).
- Persistent WS, переиспользуемый между utterance — экономит ~200 мс
  на втором+ запросе, но добавляет keep-alive / reconnect / cleanup
  состояния. Откладываю в follow-up; измерим, надо ли.
- Reconnect WS при разрыве посреди utterance — фейлим turn, пользователь
  повторяет.
- Partial-transcript deltas в UI — нам нужен только final.

## Механизм: Realtime API transcription-only

- `wss://api.openai.com/v1/realtime?intent=transcription`
- Заголовки: `Authorization: Bearer <key>`, `OpenAI-Beta: realtime=v1`.
- Initial event после `session.created`:
  ```json
  {
    "type": "transcription_session.update",
    "session": {
      "input_audio_format": "pcm16",
      "input_audio_transcription": {
        "model": "gpt-4o-transcribe",
        "language": "ru"
      },
      "turn_detection": null
    }
  }
  ```
  `turn_detection: null` — VAD у нас локальный, рулим коммитом сами.
- Push фреймов: `{ "type": "input_audio_buffer.append", "audio": "<base64 PCM16 LE>" }`.
- Финал: `{ "type": "input_audio_buffer.commit" }`, ждём
  `conversation.item.input_audio_transcription.completed` →
  `.transcript`. Закрываем WS.
- Альтернатива (`/v1/audio/transcriptions` со `stream: true`) отвергнута:
  стримит только output после полной загрузки файла — не помогает с
  capture-фазой.

## Тайминг открытия WS

**Проблема:** wake-event → пользователь сразу говорит команду, а WS
handshake может занять 100-500 мс. Если ждать `OPEN` синхронно — добавим
эту задержку в latency turn'а.

**Решение:** WS-открытие fire-and-forget стартует на `startCapture`
эффекте, capture-флаг ставится сразу. Фреймы внутри сессии
буферизуются локально пока WS не открылся.

Конкретно:

- `Stt.startSession({sampleRate, language})` возвращает `SttSession`
  **синхронно** (или резолвится без await на handshake). Внутри уже
  запущен `new WebSocket(...)`, очередь `pendingFrames: Buffer[]`.
- `session.pushAudio(frame)`:
  - Если WS открыт и `session.created` пришло → шлём `append` сразу.
  - Иначе → push в `pendingFrames`.
- На событии `session.created`: flush `pendingFrames` в WS, очищаем.
- `session.finalize()`: если WS ещё не готов — `await` пока не
  откроется и не зафлашится очередь, потом commit, потом ждём
  `completed`. На WS-ошибке/закрытии — reject.
- `session.abort()`: `ws.close()`, любой ожидающий `finalize()`
  reject'ится с `AbortError`.

Память: фрейм 80 мс @ 16 kHz моно = 2560 байт. Секунда речи в
очереди = ~32 KB. Проблем нет даже на Pi.

## Интерфейсы ([src/audio/types.ts](../../../src/audio/types.ts))

```ts
export interface SttSession {
  /** PCM16 LE моно frame на той же sample rate, что заявлена в startSession. */
  pushAudio(frame: Int16Array): void;
  /** Commit оставшегося буфера + ждём final transcript + close. */
  finalize(): Promise<string>;
  /** Hard-cut: закрываем WS, finalize() reject'ится AbortError. */
  abort(): void;
}

export interface Stt {
  /** Buffer-based, для тестов и push-to-talk. Реализуется через startSession(). */
  transcribe(audio: Buffer, opts: { sampleRate: number; language?: string }): Promise<string>;
  /** Streaming-сессия, синхронный возврат — handshake идёт в фоне. */
  startSession(opts: { sampleRate: number; language?: string }): SttSession;
}
```

## Реализация [src/audio/openaiStt.ts](../../../src/audio/openaiStt.ts)

Новый класс `OpenAiSttSession`:

- В конструкторе: `new WebSocket(url, {headers: {...}})` (пакет `ws`,
  добавляем в deps).
- Состояния: `connecting | open | committing | closed | aborted`.
- `pendingFrames: Buffer[]`. `transcriptResolve / transcriptReject` —
  коллбеки для `finalize()`.
- `ws.on('open')` → ничего, ждём `session.created`.
- `ws.on('message')`:
  - `session.created` → шлём `transcription_session.update`, флашим
    `pendingFrames`.
  - `conversation.item.input_audio_transcription.completed` → резолвим
    `transcriptResolve` с `event.transcript`.
  - `error` event → `transcriptReject` с описанием.
- `ws.on('close')` → если `finalize()` уже зарезолвился — ок; иначе
  reject «WS closed prematurely».
- `pushAudio(frame: Int16Array)`: PCM16 → base64 → если `open` —
  отправляем `append`, иначе — push в `pendingFrames`.
- `finalize()`: если ещё `connecting` — ждём перехода в `open` (через
  внутренний promise), потом flush, потом отправляем `commit`,
  возвращаем promise транскрипта.
- `abort()`: ставим `aborted`, `ws.close(1000)`, reject pending
  finalize.

`OpenAiStt.startSession()` — фабрика поверх `OpenAiSttSession`.
`OpenAiStt.transcribe(buf)` — открывает сессию, режет буфер на фреймы
(20-80 мс), пушит, finalize. (Можно push'ить целиком одним append —
API не требует разбивки.)

## Интеграция в Orchestrator

Изменения в [src/orchestrator/orchestrator.ts](../../../src/orchestrator/orchestrator.ts):

- Поле `private currentSttSession: SttSession | null = null`.
- Поле `private captureBuffer: Buffer[]` **удаляется** — больше не
  нужно хранить аудио, оно уходит в WS.
- `startCapture` эффект: `this.currentSttSession = this.opts.stt.startSession({sampleRate, language: 'ru'})`.
- `mic.onFrame` пока capturing: `this.currentSttSession?.pushAudio(frame)`.
- `endCapture()`: dispatch `utteranceEnd` **без `audio` payload**.
- `transcribeAndAsk` эффект → переименовываем в `respondToUser`,
  payload убираем. Внутри:
  ```ts
  case 'respondToUser':
    const session = this.currentSttSession;
    this.currentSttSession = null;
    if (!session) return;
    try {
      const text = (await session.finalize()).trim();
      // дальше как сейчас: empty-check, agent.respond, agentReplied
    } catch (e) { ... }
    return;
  ```
- `abortCapture` (новый эффект) — на barge-in или ошибке во время
  capture: `this.currentSttSession?.abort(); this.currentSttSession = null`.

Изменения в [src/orchestrator/types.ts](../../../src/orchestrator/types.ts):

- `Effect`: переименование `transcribeAndAsk` → `respondToUser`,
  убираем `audio` поле. Добавляем `abortCapture`.
- `Event`: `utteranceEnd` теряет `audio`.

Изменения в [src/orchestrator/fsm.ts](../../../src/orchestrator/fsm.ts):

- Транзишены не меняются концептуально, только payload эффектов/событий.

## Тесты

- **`OpenAiStt` unit** ([tests/audio/openaiStt.test.ts](../../../tests/audio/openaiStt.test.ts)):
  - Мок `ws` (через `vi.mock('ws', ...)`): фейковый WebSocket с
    управляемыми событиями.
  - Кейсы:
    1. Сессия открывается, шлёт `transcription_session.update` после
       `session.created`.
    2. `pushAudio` до `session.created` буферизуется, флашится после.
    3. `finalize()` шлёт `commit` и резолвится текстом из
       `transcription.completed`.
    4. `abort()` закрывает WS, `finalize()` reject'ится.
    5. WS error до finalize → finalize reject.
    6. `transcribe(buf)` совместимость — пушит весь буфер, финализит.

- **Orchestrator unit** ([tests/orchestrator/orchestrator.test.ts](../../../tests/orchestrator/orchestrator.test.ts)):
  - Фейковая `Stt` с фейковой сессией: подменяем pushAudio/finalize/abort
    на spy.
  - Кейсы:
    1. На `wake` → `startSession` вызван, `pushAudio` зовётся на каждом
       фрейме во время capture.
    2. На VAD silence → `finalize` вызван, текст идёт в agent.
    3. Barge-in во время capture (если возможен в FSM) → `abort` вызван.
    4. Empty transcript → как сейчас, `speechFinished` без agent-вызова.

- **Integration** (`RUN_INTEGRATION=1`):
  - Реальный API, фикстура — короткое русское аудио (3-5 сек), проверить
    что `finalize()` возвращает осмысленный текст.

- **Smoke (manual):**
  - `npm run start`, замер времени между концом речи (тишина) и blip
    подтверждения / первым звуком ответа. До: ~700-1500 мс. Ожидание:
    ~200-500 мс.

## Риски

- **Стоимость Realtime API.** Биллится отдельно, проверить на первом
  счёте. Для STT-only сессий цена сопоставима с `gpt-4o-transcribe`,
  но не идентична.
- **WS handshake spike.** В среднем 100-300 мс, хвост может быть
  500-1000 мс на медленной сети. Митигировано буферизацией фреймов
  локально (см. «Тайминг» выше).
- **`turn_detection: null` поддержка.** Должна быть, но проверить на
  первом запуске — если API требует server-side VAD, переключимся на
  `server_vad` и уберём локальный VAD как событийный триггер для commit.
- **`ws` пакет.** Добавляем в deps. Стабильный, мейнстрим.
- **Loss of `captureBuffer`.** Сейчас в orchestrator `captureBuffer`
  держит сырое аудио — потенциально полезно для отладки. После
  изменения — нет. Если будет нужно, добавим debug-режим, который
  пишет mirror в файл.
