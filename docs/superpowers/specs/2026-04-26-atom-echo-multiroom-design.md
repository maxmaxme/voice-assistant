# ATOM Echo Multiroom Voice Satellites — Research & Design

**Date:** 2026-04-26  
**Status:** Research / Decision pending

## Цель

Добавить поддержку нескольких голосовых узлов в разных комнатах. Каждый узел — M5Stack ATOM Echo ($13): микрофон + динамик + ESP32 + Wi-Fi. Все узлы обращаются к одному OpenAI agent на главном Raspberry Pi 5.

## Требования

- Несколько ATOM Echo в разных комнатах (количество TBD)
- Микрофон и динамик могут быть в **разных комнатах** (пользователь говорит в одной, отвечает в другой — или одно устройство в комнате)
- Обработка запросов **по очереди** (queue), не параллельно
- STT — на Pi (`gpt-4o-transcribe`)
- TTS — на Pi (`gpt-4o-mini-tts`), аудио отправляется обратно на ATOM Echo
- Wake-word: `hey_jarvis` (предпочтительно)

## Оборудование: ATOM Echo

- ESP32 (Wi-Fi 802.11 b/g/n, BLE 4.0)
- Микрофон: SPM1423 (PDM), пины G19/G33
- Динамик: NS4168 0.8W (I²S), пины G22/G23/G19
- RGB LED (SK6812)
- Размер: 24×24×17 мм

## Исследование: ESPHome firmware

Официальный репозиторий `esphome/wake-word-voice-assistants` содержит готовый YAML для ATOM Echo:

- Wake-word **на устройстве** через `micro_wake_word` с моделями: `okay_nabu`, `hey_mycroft`, **`hey_jarvis`**
- Микрофон 16kHz, VAD (обнаружение речи), LED feedback
- Pipeline: `idle → wake → listen (VAD) → stream → response → idle`
- **Ограничение:** ESPHome `voice_assistant` жёстко привязан к Home Assistant — кастомный endpoint не поддерживается

## Два варианта архитектуры

### Вариант A: ESPHome + HA как transport

```
ATOM Echo (ESPHome firmware, готовый)
  → wake-word локально (hey_jarvis ✓)
  → stream audio → Home Assistant Assist
  → HA кастомный Conversation Agent → твой Pi agent
  → TTS audio → HA → ATOM Echo
```

**Плюсы:**

- Wake-word `hey_jarvis` работает из коробки
- LED, VAD, мультирум — всё готово в ESPHome
- HA уже есть в `deploy/docker-compose.yml`
- Firmware не нужно писать

**Минусы:**

- HA в цепочке — лишнее звено
- Нужно написать HA custom integration (Python) для bridge к Pi agent
- Зависимость от HA Assist pipeline

**Что нужно реализовать:**

1. HA custom integration: `custom_components/pi_agent_bridge/` — проксирует STT/TTS/conversation к Pi
2. REST/WebSocket API на Pi для приёма запросов от HA
3. Новый runner `src/cli/runners/ha-bridge.ts` в agent

---

### Вариант B: Кастомный Arduino firmware

```
ATOM Echo (Arduino)
  → ESP-SR wake-word (библиотека Espressif)
  → I2S mic → буфер → WebSocket → Pi напрямую
  → agent обрабатывает
  → TTS audio → WebSocket → I2S speaker
```

**Плюсы:**

- Прямое соединение без HA
- Полный контроль над протоколом
- Проще debugging

**Минусы:**

- Firmware нужно писать с нуля (I2S, Wi-Fi, WebSocket, wake-word)
- ESP-SR ограничен фиксированными фразами (нет `hey_jarvis`, есть `Hi Lexin`, `Hi M5` и похожие)
- Больше работы по сравнению с вариантом A

**Что нужно реализовать:**

1. Arduino sketch для ATOM Echo (I2S mic/speaker + ESP-SR + WebSocket)
2. WebSocket аудио-сервер на Pi
3. Новый adapter `src/audio/atomEchoInput.ts` + `src/audio/atomEchoOutput.ts`
4. Очередь запросов от нескольких устройств

---

## Сравнение

| Критерий               | A (ESPHome + HA)      | B (Arduino)        |
| ---------------------- | --------------------- | ------------------ |
| Wake-word `hey_jarvis` | ✅                    | ❌ (другая фраза)  |
| Объём кода             | Меньше                | Больше             |
| Зависимости            | HA в цепочке          | Прямо              |
| LED/VAD из коробки     | ✅                    | ❌ (писать самому) |
| Отладка                | Сложнее (3 звена)     | Проще              |
| Масштабирование        | ESPHome сам управляет | Вручную            |

## Открытые вопросы

- [ ] Сколько ATOM Echo устройств планируется?
- [ ] Нужна ли сессия/память per-device или общая?
- [ ] Приоритет: `hey_jarvis` важнее или прямое соединение без HA?
- [ ] Как обрабатывать barge-in (прервать TTS на одном устройстве если wake на другом)?
- [ ] Нужна ли очередь с приоритетами (например, конкретная комната важнее)?

## Связанные файлы в проекте

- `src/audio/wakeWord.ts` — текущий wake-word через openWakeWord daemon
- `src/audio/micInput.ts` — локальный микрофон
- `src/audio/speakerOutput.ts` — локальный динамик (aplay/speaker)
- `src/orchestrator/` — FSM состояний (idle/listening/thinking/speaking)
- `src/cli/runners/wake.ts` — текущий runner для wake-word режима
- `deploy/docker-compose.yml` — Pi prod stack с HA

## Ссылки

- [ESPHome ATOM Echo YAML](https://github.com/esphome/wake-word-voice-assistants/blob/main/m5stack-atom-echo/m5stack-atom-echo.yaml)
- [ESPHome voice_assistant docs](https://esphome.io/components/voice_assistant.html)
- [HA $13 voice remote guide](https://www.home-assistant.io/voice_control/thirteen-usd-voice-remote/)
- [M5Stack ATOM Echo docs](https://docs.m5stack.com/en/atom/atomecho)
