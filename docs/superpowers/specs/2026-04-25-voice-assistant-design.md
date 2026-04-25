# Голосовой ассистент для умного дома — дизайн

**Дата:** 2026-04-25
**Статус:** Draft (на будущее, до появления железа и Home Assistant)
**Автор:** Maxim Lepekha

## Цель

Голосовой ассистент на Node.js, работающий локально на Raspberry Pi и
управляющий умным домом через Home Assistant по протоколу MCP. Разработка
ведётся на macOS, целевой деплой — Raspberry Pi. На момент написания спеки
ни Home Assistant, ни умных устройств у пользователя нет: проектируем «вперёд»
и начнём с моков.

## Принципы

- **Изолированные модули с фиксированными интерфейсами.** Заменa провайдера
  (например, ElevenLabs вместо OpenAI TTS) = новый адаптер с тем же контрактом,
  без изменений в остальных модулях.
- **Кроссплатформенность macOS / Linux ARM.** Все нативные зависимости должны
  иметь сборки под обе платформы.
- **Cloud-heavy режим по умолчанию.** STT, LLM и TTS — облачные, ради качества.
  Wake-word — локально, ради приватности и стоимости. Локальные альтернативы
  допускаются позже как сменные адаптеры.
- **YAGNI.** Не строим того, что не подтверждено реальной потребностью.

## Архитектура

```
┌─ Raspberry Pi ──────────────────────────────────────┐
│                                                     │
│  Mic ─► Wake-word ─► VAD ─► Audio buffer            │
│        (Porcupine,                                  │
│         локально)                                   │
│                          │                          │
│                          ▼                          │
│                  ┌─ Orchestrator ─┐                 │
│                  │  (Node.js)     │                 │
│                  └───────┬────────┘                 │
│                          │                          │
│  ┌───────────────────────┼──────────────────────┐   │
│  │                       ▼                      │   │
│  │  STT: OpenAI gpt-4o-transcribe (cloud)       │   │
│  │  LLM: Claude/GPT с tool-calling (cloud)      │   │
│  │       └─► MCP client ─► HA /api/mcp          │   │
│  │  TTS: OpenAI gpt-4o-mini-tts (cloud)         │   │
│  └──────────────────────────────────────────────┘   │
│                          │                          │
│                          ▼                          │
│                       Speaker                       │
└─────────────────────────────────────────────────────┘
```

## Технологический стек

| Слой            | Решение                                                              | Обоснование                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wake-word       | Picovoice Porcupine (Node SDK)                                       | Офлайн, ARM-сборка, бесплатно для personal                                                                                                                                                          |
| VAD             | Silero VAD или встроенный VAD OpenAI                                 | Определение конца фразы                                                                                                                                                                             |
| STT             | OpenAI `gpt-4o-transcribe`                                           | Выбор пользователя; высокое качество, поддержка русского                                                                                                                                            |
| LLM             | Claude / GPT с tool-calling                                          | Нативный MCP-клиент через `@modelcontextprotocol/sdk`                                                                                                                                               |
| MCP-клиент      | `@modelcontextprotocol/sdk`                                          | Официальный SDK, Streamable HTTP-транспорт                                                                                                                                                          |
| Home Assistant  | Встроенная интеграция `mcp_server` (HA 2025.2+), endpoint `/api/mcp` | Один источник истины об устройствах; контроль доступа через voice exposure                                                                                                                          |
| TTS             | OpenAI `gpt-4o-mini-tts`                                             | Один провайдер с STT, поддержка русского, инструкции к голосу                                                                                                                                       |
| Микрофон        | `node-record-lpcm16` или `mic`                                       | Работает на macOS и Linux                                                                                                                                                                           |
| Воспроизведение | `speaker` или системный `aplay`/`afplay`                             | Простота                                                                                                                                                                                            |
| Память          | SQLite через `better-sqlite3`                                        | Полноценная БД в одном файле, без отдельного сервера; пребилт-бинари под macOS (x64/arm64) и Linux arm64 — на Pi и Mac работает одинаково; растёт в векторный поиск через `sqlite-vss`/`sqlite-vec` |
| Runtime         | Node.js 20 LTS, ESM (`"type": "module"`)                             | Современный путь для Node-проектов; MCP SDK ESM-first                                                                                                                                               |

## Модули

Каждый модуль — отдельный файл/пакет с фиксированным контрактом. Все провайдеро-зависимые
модули реализованы как адаптеры: интерфейс — в коде проекта, реализация — в адаптере.

| Модуль         | Ответственность                                                | Интерфейс                                         |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `audio-input`  | Захват PCM с микрофона                                         | `AsyncIterable<Int16Array>`                       |
| `wake-word`    | Детект ключевой фразы локально                                 | event `wake`                                      |
| `vad`          | Определение конца фразы                                        | event `utteranceEnd`                              |
| `stt`          | Аудио → текст                                                  | `transcribe(buf: Buffer): Promise<string>`        |
| `agent`        | Текст → tool-calls → текст                                     | `respond(text: string, history): Promise<string>` |
| `mcp-client`   | Соединение с HA MCP                                            | `listTools()`, `callTool(name, args)`             |
| `tts`          | Текст → PCM-аудио                                              | `synthesize(text: string): Promise<Buffer>`       |
| `audio-output` | Воспроизведение                                                | `play(buf: Buffer): Promise<void>`                |
| `memory`       | Долгосрочный профиль пользователя (SQLite)                     | `remember(k,v)` / `recall(k?)` / `forget(k)`      |
| `orchestrator` | FSM состояний (`idle` / `listening` / `thinking` / `speaking`) | —                                                 |

### Контракты адаптеров (примеры)

```ts
interface SttAdapter {
  transcribe(audio: Buffer, opts?: { language?: string }): Promise<string>;
}

interface TtsAdapter {
  synthesize(text: string, opts?: { voice?: string; instructions?: string }): Promise<Buffer>;
}

interface LlmAdapter {
  respond(input: { text: string; history: Message[]; tools: Tool[] }): Promise<{
    text: string;
    toolCalls: ToolCall[];
  }>;
}
```

## Поток одной команды

1. Состояние `idle`. Wake-word слышит ключевую фразу → переход в `listening`.
2. VAD аккумулирует аудио до тишины → буфер.
3. Буфер → `stt.transcribe()` → текст.
4. Текст + история диалога + MCP-tools → `agent.respond()`.
5. Агент делает tool-calls через MCP-клиент в Home Assistant. Возможно несколько раундов.
6. Финальный текстовый ответ → `tts.synthesize()` → `audio-output.play()`.
7. Возврат в `idle`.

## Контекст диалога

Ассистент должен поддерживать продолжение разговора: «какая погода? → а завтра?»
второй запрос должен пониматься в контексте первого.

### Краткосрочная память (in scope)

| Параметр          | Значение                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Хранилище         | In-memory в `orchestrator` — массив сообщений                                                  |
| Содержимое        | Реплики пользователя, ответы ассистента, результаты tool-calls                                 |
| Сброс по таймауту | 3 минуты тишины с момента последней реплики                                                    |
| Сброс по команде  | Явные фразы вида «забудь / новый разговор / начни заново»                                      |
| Wake-word         | НЕ сбрасывает контекст: продолжает текущий диалог, если таймаут не вышел                       |
| Лимит             | Последние ~20 реплик или ~4k токенов (что раньше); обрезка с начала, system prompt сохраняется |
| Персистентность   | Нет. Перезапуск процесса = чистый контекст                                                     |

Параметры (timeout, лимиты) — в `config.json`, чтобы можно было крутить без правки кода.

### Долгосрочная память — итерация 1: профиль пользователя

Структурированные факты о пользователе: имя, комфортная температура, режим дня,
предпочтения. Десятки записей, не больше. LLM сама решает, когда сохранить / прочитать,
через tools.

**Хранилище — SQLite (`better-sqlite3`).** Не JSON-файл: нужны транзакции,
индексы, схема и место под рост (в будущем — векторный поиск через `sqlite-vss`/
`sqlite-vec` тем же файлом). Один процесс, без сервера — оптимально для Pi.

Схема:

```sql
CREATE TABLE profile (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,         -- JSON-encoded
  updated_at INTEGER NOT NULL       -- unix epoch
);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
```

Файл — `data/assistant.db`, в `.gitignore`. Миграции — `migrations/NNN.sql`
плюс таблица `schema_version`.

Tools, доступные LLM:

```ts
remember({ key: string, value: any }): void
recall({ key?: string }): Record<string, any>   // без key — весь профиль
forget({ key: string }): void
```

Адаптер `MemoryAdapter` — тот же интерфейс, что и для будущих уровней. Реализация
для итерации 1 — `SqliteProfileMemory`. Весь профиль маленький, поэтому подкладывается
в system prompt каждого запроса целиком (без RAG).

### Долгосрочная память — следующие итерации (out of scope сейчас)

- **Итерация 2 — эпизодическая память.** Суммаризация прошлых диалогов + векторный
  поиск через `sqlite-vss`/`sqlite-vec` (тот же `.db`-файл). Подключается, если
  начнут возникать реальные «помнишь, мы говорили про…».
- **Итерация 3 — выученные привычки.** В большинстве случаев заменяется явными
  HA automations + еженедельным suggestions-промптом по логам. Не строим, пока
  не появится конкретный кейс.

Все три уровня живут за одним интерфейсом `MemoryAdapter`, оркестратор не знает,
какой адаптер подключён.

## Конфигурация

`.env` (в `.gitignore`):

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
HA_URL=https://homeassistant.local:8123
HA_TOKEN=...                 # Long-Lived Access Token
PORCUPINE_ACCESS_KEY=...
PORCUPINE_KEYWORD=jarvis        # built-in Porcupine keyword (или путь к .ppn)
LANGUAGE=ru
```

`config.json` — модели, идентификатор голоса, лимиты, параметры VAD.

## Этапы реализации

Каждый этап — самостоятельный, работающий результат, снимающий конкретный риск.

1. **MCP-клиент против HA-мока.**
   - Поднять HA в Docker на Mac.
   - Включить интеграцию `mcp_server`, выпустить Long-Lived Access Token.
   - Node.js-скрипт через `@modelcontextprotocol/sdk` подключается, запрашивает tools, вызывает «turn_on light» на mock-устройстве.
   - Без голоса. Цель — проверить транспорт и аутентификацию.

2. **Текстовый агент.**
   - LLM-адаптер (Claude или GPT) с tool-calling.
   - stdin → LLM с MCP-tools → stdout.
   - Управление домом текстом из терминала. Цель — отладить промпт и tool-loop.

3. **Голос на macOS.**
   - mic → STT → агент → TTS → speaker.
   - Без wake-word, push-to-talk пробелом.
   - Цель — проверить аудио-pipeline и латенси на «нормальной» железке.

4. **Wake-word + VAD.**
   - Always-listening pipeline на macOS.
   - FSM состояний.

5. **Деплой на Raspberry Pi.**
   - systemd-сервис, ALSA вместо CoreAudio, ARM-сборки нативных модулей.
   - Цель — финальная среда исполнения.

## Тестирование

- **Unit:** каждый адаптер с замокированным провайдером.
- **Интеграция:** MCP-клиент против реального HA в Docker.
- **E2E:** записанное `.wav` прогоняется через весь pipeline, проверяются вызванные MCP-tools.

## Что вне scope

- Мультиюзер и распознавание говорящего.
- Барж-ин (прерывание ассистента голосом).
- Свой web-UI или мобильное приложение.
- Кастомные skills вне HA (таймеры, погода и т.д.) — это уже умеет сам Home Assistant.
- Локальный fallback STT/LLM/TTS на старте — добавится как новый адаптер при необходимости.
- Эпизодическая и процедурная долгосрочная память (см. раздел «Долгосрочная память»).

## Риски

| Риск                                 | Митигация                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Латенси cloud-pipeline               | Streaming STT и streaming TTS, начинать TTS до окончания LLM                                                        |
| Расходы на API                       | Лимиты в config; позже — локальный fallback через адаптер                                                           |
| HA ещё нет                           | Стартуем с моков; контракт MCP-клиента не зависит от наличия HA                                                     |
| Нативные модули на Pi                | Заранее проверять ARM-совместимость, предпочитать pure-JS                                                           |
| Утечка ключей API                    | `.env` в `.gitignore`, не коммитить; ключи только на устройстве                                                     |
| База памяти разрастётся / повредится | SQLite-файл в `data/`, регулярные `VACUUM`; периодический бэкап копированием `.db`; миграции через `schema_version` |

## Ссылки

- Home Assistant MCP Server: <https://www.home-assistant.io/integrations/mcp_server/>
- MCP TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- Picovoice Porcupine: <https://picovoice.ai/platform/porcupine/>
- OpenAI Realtime / Audio API: <https://platform.openai.com/docs/guides/audio>
