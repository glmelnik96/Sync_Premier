# План миграции на macOS

Плагин разрабатывался на Windows, но архитектурно **кросс-платформенный** — это
CEP-расширение (HTML/JS + ExtendScript), которое Adobe CEP-runtime запускает одинаково
на Windows и macOS. Большая часть кода уже работает на обеих ОС. Этот документ —
чек-лист того, что проверить и поправить при переносе на Mac.

## TL;DR

Кода для переписывания почти нет. Основная работа — **окружение** (PlayerDebugMode,
путь установки, ffmpeg) и **проверка платформо-зависимых мест** (ниже). Расчётное
состояние: «работает после правильной установки + 1–2 мелкие проверки».

---

## 1. Что УЖЕ кросс-платформенно (трогать не нужно)

| Компонент | Почему работает на Mac |
|---|---|
| `audio-envelope.js` поиск ffmpeg | Уже проверяет `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `/usr/bin/ffmpeg` и `which ffmpeg` на non-Windows |
| `host/premiere-sync.jsx` | `Folder.temp.fsName` — кросс-платформенный temp; `File`/`importFiles`/`exportAsFinalCutProXML` есть в ExtendScript на обеих ОС |
| `fcpxml-transform.js` | Чистые строковые операции над XML; `file://localhost/...` pathurl декодируется одинаково |
| `sync-core/graph/runner` | Чистая математика, без I/O и путей |
| `bridge-premiere.js` | Нормализует пути (`\` → `/`), экранирование — платформо-независимо |
| `CSXS/manifest.xml` | Нет хардкод-путей; `--enable-nodejs`, `--mixed-context` работают на обеих ОС |
| Тики/кадры (pproTicks) | Универсальны для FCP7 XML вне зависимости от ОС |

## 2. Что ПРОВЕРИТЬ на Mac (потенциальные правки)

### 2.1 Тип файловой ссылки при установке
- Windows использует **junction** (`New-Item -ItemType Junction`).
- macOS использует **symlink** (`ln -s`).
- → см. блок «Установка» в README. Код от этого не зависит.

### 2.2 ffmpeg
- Установить: `brew install ffmpeg`.
- Проверить, что находится: в панели DevTools выполнить
  `window.AudioEnvelope.findFfmpegPath()` — должен вернуть путь, не `null`.
- Если ffmpeg в нестандартном месте — добавить путь в массив `cands` в
  `client/shared/audio-envelope.js:16` (или положить симлинк в `/usr/local/bin`).

### 2.3 Кодировка путей с не-ASCII символами
- На Windows был баг: кириллица в пути ломала `File()` при экспорте → решено записью
  во `Folder.temp` (ASCII-путь). На Mac temp-путь обычно ASCII (`/var/folders/...`),
  но если профиль с кириллицей — поведение то же, и решение уже применено.
- **Проверить:** `exportActiveSequenceXml` создаёт файл и панель его читает.

### 2.4 Перенос строк (CRLF/LF)
- На Windows git показывает `LF will be replaced by CRLF`. На Mac — LF.
- FCP7 XML, который пишет Premiere, и парсинг в `fcpxml-transform.js` используют
  `\n\t\t\t<audio>` как границу аудио-региона. **Проверить:** экспорт Premiere на Mac
  даёт тот же отступ (обычно да — формат фиксирован). Если границы региона не находятся —
  ослабить regex (искать `<audio>` без жёсткой привязки к табам).

### 2.5 timebase/fps
- `deriveRate()` берёт `<timebase>`/`<ntsc>` из XML — fps-агностично. Тестовый материал
  был 23.976 (timebase 24 ntsc). **Проверить** на проекте с другим fps (25, 29.97, 50).

### 2.6 Версия CSXS / PlayerDebugMode
- `manifest.xml` требует CSXS 12 (Premiere 2024+). На Mac включить через
  `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` + `killall cfprefsd`.
- Если Premiere старее — понизить `RequiredRuntime` и включить соответствующий CSXS.N.

## 3. Что НЕ перенесётся как есть

| Элемент | Проблема | Действие |
|---|---|---|
| `tools/cep-debug.mjs` порт 8100 | Работает и на Mac (CDP по TCP), но `.debug` порт можно занять | Обычно ОК; при конфликте сменить порт в `.debug` + `CEP_DEBUG_PORT` |
| Junction-команда в README | PowerShell-only | Использовать `ln -s` (уже в README) |
| Абсолютные пути в дев-командах | `C:\путь\к\Sync_Premier` | Заменить на `/путь/к/Sync_Premier` |

## 4. Чек-лист переноса (по шагам)

1. Склонировать репозиторий на Mac.
2. `brew install ffmpeg` → проверить `which ffmpeg`.
3. `defaults write com.adobe.CSXS.12 PlayerDebugMode 1 && killall cfprefsd`.
4. `ln -s "$(pwd)" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gleb.aisync"`.
5. Перезапустить Premiere → открыть панель «ИИ: синхронизация».
6. `npm test` — все тесты должны пройти (чистая математика, ОС-независимы).
7. Открыть тестовую секвенцию → «Синхронизировать» → проверить создание `_SYNCED`.
8. Прогнать DevTools-проверки: `findFfmpegPath()` ≠ null; экспорт/импорт XML работают.
9. Если что-то не находит регион аудио в XML (см. 2.4) — поправить regex границы.

## 5. Подпись расширения (опционально, для распространения)

Пока расширение неподписанное (работает только с PlayerDebugMode). Для раздачи без
DebugMode — подписать через **ZXPSignCmd** (Adobe) и упаковать в `.zxp`; устанавливать
через **Anastasiy's Extension Manager / ZXPInstaller**. Это одинаково для Win/Mac,
делается один раз при релизе.
