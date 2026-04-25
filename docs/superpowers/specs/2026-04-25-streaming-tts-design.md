# Streaming TTS — design

Streaming PCM от `gpt-4o-mini-tts` вместо ожидания полного буфера.
Цель: первый звук через ~300 мс после отправки запроса вместо текущих
2-3 секунд; на длинных ответах round-trip падает на 1-3 секунды.

Источник: [docs/superpowers/roadmap.md](../roadmap.md), раздел «Голос и
аудио → Streaming TTS».

## Скоп

**В скопе:**

- TTS-слой ([src/audio/openaiTts.ts](../../../src/audio/openaiTts.ts))
  отдаёт PCM по мере прихода от OpenAI.
- Speaker-слой
  ([src/audio/speakerOutput.ts](../../../src/audio/speakerOutput.ts))
  принимает поток чанков и пишет их в `aplay`/`speaker` по мере
  поступления.
- Сквозная отмена через `AbortSignal` — barge-in рвёт и HTTP-стрим, и
  пайп speaker'а.
- Перевод blip (короткий confirm-звук) и call-сайтов в orchestrator/CLI
  на новый API.

**Вне скопа:**

- Streaming LLM responses — отдельный пункт roadmap, требует
  изменений в агенте.
- Sentence-chunking / параллельный синтез нескольких предложений.
- Backwards-compat шим над старым `synthesize()` — у проекта один
  продакшн-путь, оба call-сайта переводим за раз.

## Интерфейсы ([src/audio/types.ts](../../../src/audio/types.ts))

```ts
export interface Tts {
  stream(
    text: string,
    opts?: { voice?: string; instructions?: string; signal?: AbortSignal }
  ): TtsStream;
}

export interface TtsStream {
  sampleRate: number;
  chunks: AsyncIterable<Buffer>; // 16-bit mono PCM, по мере прихода
}

export interface SpeakerOutput {
  playStream(
    stream: { chunks: AsyncIterable<Buffer>; sampleRate: number },
    opts?: { signal?: AbortSignal }
  ): Promise<void>;
  stop(): void; // синхронный hard-cut — оставляем
}
```

Старые `Tts.synthesize()` и `SpeakerOutput.play(buf, …)` удаляются
целиком.

`sampleRate` лежит на объекте-стриме, не на каждом чанке: для одного
синтеза он фиксирован (24 kHz у `gpt-4o-mini-tts`).

## Реализация TTS

`OpenAiTts.stream()` возвращает объект с `sampleRate` и
`AsyncGenerator`, который:

1. Зовёт `client.audio.speech.create({...response_format:'pcm'}, {signal})`.
2. Берёт `.body` (Web `ReadableStream<Uint8Array>`), читает циклом
   `reader.read()`.
3. Для каждого ненулевого чанка `yield Buffer.from(value)`.
4. На abort SDK выкидывает `AbortError` — пробрасываем наружу,
   оркестратор интерпретирует как нормальную отмену.

Никакой буферизации/реалайнмента: 16-битный mono на 24 kHz даёт
чётное число байт всегда; промежуточные размеры чанков (4-16 KB,
как fetch их режет) safe для пайпов.

## Реализация Speaker

Оба бэкенда уже работают на пайпах — добавляем `playStream`,
который кормит их по мере прихода чанков.

**Linux (`aplay`):**

- `spawn('aplay', ['-q','-t','raw','-f','S16_LE','-r',sr,'-c','1'])`
  один раз перед циклом.
- `for await (const chunk of stream.chunks)`: `proc.stdin.write(chunk)`,
  если возвращает `false` — `await once(stdin, 'drain')` (backpressure).
- После цикла `stdin.end()`, ждём `'exit'` процесса.
- На abort: `signal.addEventListener('abort', () => this.stop())`,
  `stop()` синхронно kill'ит proc; `stdin.write` после этого ловит
  EPIPE — игнорируем; цикл выходит на проверке `proc.stdin.destroyed`.

**macOS (`speaker` npm):**

- Симметрично: `new Speaker({...})` один раз; `speaker.write(chunk, cb)`
  c `await` колбэка для backpressure; в конце `speaker.end()`, ждём
  `'close'`.
- На abort: `stop()` зовёт `removeAllListeners('error') + end + destroy`
  как сейчас.

**Backpressure-инвариант:** speaker не примет следующий чанк → TTS
итератор повиснет на `yield` → `reader.read()` от OpenAI не вызовется
→ TCP-окно закроется. Памяти не накапливаем.

`stop()` остаётся без изменений — синхронный hard-cut. AbortSignal —
декларативный способ его вызвать.

## Интеграция

[src/orchestrator/orchestrator.ts](../../../src/orchestrator/orchestrator.ts)
— на `speak`-эффекте создаём `AbortController`, держим в
`this.currentSpeechAbort`. Передаём `signal` в `tts.stream()` и
`speaker.playStream()`. На stop-эффекте/событии: `controller.abort()`
+ `speaker.stop()` (hard-cut на случай если playStream-цикл ещё не
проснулся).

Helper `toStream(buf, sr)` оборачивает готовый Buffer (blip) в
`{chunks: async function*() { yield buf; }, sampleRate: sr}` —
один путь для blip и TTS.

[src/cli/voice.ts](../../../src/cli/voice.ts) — переводим call-сайт
на `playStream`/`stream`, без AbortController (REPL barge-in не имеет).

`isAbortError(e)` в catch — глотаем тихо, не логируем как TTS error.

## Тестирование

- **TTS unit:** мок `openai.audio.speech.create` возвращает
  `{body: ReadableStream}` из массива `[chunk1, chunk2, chunk3]` →
  проверяем что `for await` отдаёт эти 3 буфера и `sampleRate=24000`.
- **Speaker unit (Linux):** мок `child_process.spawn` → проверяем
  порядок записи чанков, что `end()` вызван после последнего, что
  abort убивает proc.
- **Backpressure unit:** speaker-stub с `write() === false` → цикл
  ждёт `'drain'` перед следующей записью.
- **Abort unit:** playStream с уже-aborted signal → ничего не пишется,
  promise резолвится без ошибки.
- **Smoke (manual):** `npm run voice` локально, замер времени между
  «User: …» и первым звуком на коротком и длинном ответе; ожидаем
  <500 мс short, кратное ускорение long.

## Риски

- **OpenAI SDK API.** Версия SDK в `package.json` должна поддерживать
  передачу `{signal}` вторым аргументом и возвращать body как
  Web ReadableStream. Если нет — fallback на raw fetch к
  `/v1/audio/speech` с теми же заголовками. Проверить при имплементации.
- **`speaker` npm и backpressure.** Пакет старый; формально `write()`
  принимает callback, но streaming-семантика может быть кривой. Если
  всплывут проблемы — fallback аналогичный Linux: spawn `play`/`sox`,
  пайп через stdin. Решаем при первом тестировании на mac.
- **Blip через playStream.** Накладные расходы spawn aplay для
  100 мс blip существуют, но они и сейчас есть в текущем коде —
  поведение не меняется.
