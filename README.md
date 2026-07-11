# ИИ: синхронизация — CEP-плагин для Premiere Pro

Автоматическая синхронизация многокамерного материала по общему звуку
(кросс-корреляция RMS-огибающих). Камеры и аудио-рекордеры выравниваются на общую
шкалу времени; материал из разных «комнат» (без общего звука) разносится последовательно;
клипы без надёжной аудио-связи позиционируются по timecode либо помечаются красным.

Плагин самостоятельный, не часть «ИИ: монтаж».

## Как это работает (архитектура)

Плагин использует **FCP7 XML round-trip**, а не прямую правку таймлайна. По кнопке
«Синхронизировать»:

1. **Экспорт** активной секвенции в FCP7 XML (`exportAsFinalCutProXML`).
2. **Анализ** в панели (Node.js): ffmpeg извлекает огибающие, FFT-NCC кросс-корреляция,
   граф комнат с корроборацией связей (модель Syncaila).
3. **Сборка** синхро-XML: позиции клипов на полную длину в одной секвенции; файлы одной
   камеры — по timecode; порядок комнат по timecode; несвязанные клипы — в конец, красные.
4. **Импорт** обратно (`importFiles`) — Premiere строит **новую** секвенцию `…_SYNCED`.

Исходная секвенция не изменяется. Подход обходит ограничения прямого `TrackItem.move()`
(длительность секвенции, плейхед, развал), из-за которых standalone-инструменты
(PluralEyes, Syncaila) тоже работают через XML, а не как плагины.

## Возможности

- **Граф комнат**: транзитивные цепочки (A слышит B, B слышит рекордер C → одна комната),
  корроборация слабых связей (≥2 согласованных оценки), разделение несвязанного звука.
- **Спанированные камеры**: файлы одной камеры (разбита на куски, общий клок)
  позиционируются по timecode от лучшего аудио-якоря — даже куски без звукового совпадения
  встают точно.
- **Порядок комнат по timecode** — хронология съёмки из метаданных рекордера.
- **Несвязанные клипы** → в конец секвенции, помечены красным (Rose) для ручного разбора.
- **Разные fps** источников — вся математика в домене кадров/тиков (fps из XML, не захардкожен).
- **Корректный импорт**: мастер-клипы `<project>`, ссылки на файлы, хронологический порядок
  clipitem внутри дорожек (Premiere иначе роняет длинные клипы).
- **Масштаб**: протестировано до 300+ клипов / 100+ источников на секвенцию.
- **Standalone CLI** на том же движке (`standalone/sync-xml.mjs`).

## Требования

- Adobe Premiere Pro **2024+** (Host `PPRO [24.0,99.9]`, CSXS 12). Premiere 2023 и старше
  не поддерживаются (CSXS 12). Для них пришлось бы понизить `RequiredRuntime` и Host-флор.
- **ffmpeg** — используется панелью для извлечения аудио-огибающих. Ищется автоматически:
  - Windows: `C:\ffmpeg\bin\ffmpeg.exe`, scoop/choco/ProgramFiles, либо `PATH`;
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, либо `PATH` (`brew install ffmpeg`).
  - Если ffmpeg не найден — панель покажет понятную ошибку, без падения.
- Node.js встроен в CEP через `--enable-nodejs` (отдельная установка нужна только для
  тестов/CLI, ≥ 18).
- Включённый CEP **PlayerDebugMode** для неподписанного dev-расширения (см. ниже). Для
  раздачи конечным пользователям без DebugMode — подписать `.zxp` (раздел «Распространение»).

## Совместимость и стабильность

- **ExtendScript-совместимость**: host (`premiere-sync.jsx`) написан под движок ES3. Включает
  JSON-полифилл (нативного `JSON` нет в ряде версий Premiere — иначе весь host падает с
  `ReferenceError: JSON is undefined`). Не используются `.trim()`, `Array.forEach/map`,
  `Object.keys`, стрелочные функции и прочее, чего нет в ExtendScript. Вся современная
  логика (DSP, парсинг XML) — в панели (Chromium) и CLI (Node), где ES2020 доступен.
- **Без мутации таймлайна**: плагин не двигает клипы скриптом (`TrackItem.move()` ненадёжен —
  ломает длительность/плейхед). Вместо этого пишет FCP7 XML и импортирует — Premiere строит
  свежую секвенцию. Исходная секвенция не изменяется.
- **Безопасность**: ffmpeg вызывается через `execFile` с массивом аргументов (без shell →
  нет command injection даже при спецсимволах в путях). Временные файлы — только в системной
  temp-папке с фиксированными именами (нет path traversal). Вход `importSyncedXml` —
  собственный XML плагина (доверенный).
- **Большие проекты**: таймаут экспорта/импорта 600с (для 300+ клипов / 100+ источников).
- **Параллельные плагины**: debug-порт 8100 (см. `.debug`) — при одновременном запуске
  нескольких CEP-расширений в отладке убедитесь, что порт уникален.

---

## Установка

Установка = положить расширение в папку CEP-extensions + включить PlayerDebugMode.
Расширение **кросс-платформенное** (код уже поддерживает Windows и macOS).

### Windows

1. **Включить PlayerDebugMode** (один раз). В PowerShell:
   ```powershell
   reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```
   (для других версий CSXS повторить с `CSXS.11`, `CSXS.10` и т.д.)

2. **Установить расширение** — junction-симлинк репозитория в папку CEP:
   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:APPDATA\Adobe\CEP\extensions\com.gleb.aisync" `
     -Target "C:\путь\к\Sync_Premier"
   ```
   (или просто скопировать папку репозитория туда же)

3. **ffmpeg**: положить в `C:\ffmpeg\bin\ffmpeg.exe` или добавить в `PATH`.

4. Перезапустить Premiere → **Window → Extensions → «ИИ: синхронизация»**.

### macOS

1. **Включить PlayerDebugMode** (один раз). В Terminal:
   ```bash
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1
   ```
   (повторить для нужных версий: `com.adobe.CSXS.11` и т.д.; затем `killall cfprefsd`)

2. **Установить расширение** — симлинк репозитория в папку CEP:
   ```bash
   ln -s "/путь/к/Sync_Premier" \
     "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gleb.aisync"
   ```
   (или скопировать папку репозитория туда же)

3. **ffmpeg**: установить через Homebrew — `brew install ffmpeg` (определяется
   автоматически в `/opt/homebrew/bin/ffmpeg` или `/usr/local/bin/ffmpeg`).

4. Перезапустить Premiere → **Window → Extensions → «ИИ: синхронизация»**.

> Папка extensions может также быть системной:
> Windows `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions`,
> macOS `/Library/Application Support/Adobe/CEP/extensions` — но пользовательская
> (в профиле) предпочтительна и не требует прав администратора.

> **PlayerDebugMode нужен на КАЖДУЮ версию CSXS**, которую использует Premiere. Если
> панель не появляется — повторите шаг 1 для `CSXS.11`, `CSXS.10` и т.д. (Win: ключ реестра,
> Mac: `defaults write com.adobe.CSXS.N PlayerDebugMode 1 && killall cfprefsd`).

### Распространение конечным пользователям (без PlayerDebugMode)

Для раздачи без правки PlayerDebugMode расширение нужно **подписать** в `.zxp`:

1. Подписать `ZXPSignCmd` (Adobe) самоподписанным или коммерческим сертификатом.
2. Установить `.zxp` через **Anastasiy's Extension Manager** / **ZXPInstaller** (Win/Mac).

Это убирает требование PlayerDebugMode и упрощает установку для не-разработчиков. Делается
один раз при релизе; процесс одинаков на Windows и macOS.

---

## Использование

1. Откройте секвенцию с исходными клипами (камеры + аудио-рекордеры на дорожках).
2. **Window → Extensions → «ИИ: синхронизация»**.
3. Нажмите **«Синхронизировать»**.
4. По завершении в проекте появится секвенция **`<имя>_SYNCED`** — выровненный по звуку
   материал (активируется автоматически). Клипы без общего звука стоят в конце секвенции
   и помечены красным (Rose) для ручного разбора.

## CLI (standalone)

Тот же движок без Premiere — на вход FCP7 XML (экспорт из Premiere вручную):

```bash
node standalone/sync-xml.mjs вход.xml выход.xml
```

Результат `выход.xml` импортируется в Premiere (**File → Import**).

## Отладка

Debug-порт **8100** (Chrome DevTools Protocol):

```bash
CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs targets
CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs reload
CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs host '$._SYNC_.version'
```

## Тесты

```bash
npm test
```

Юнит-тесты ядра (vm-loader): FFT-кросс-корреляция, confidence-гейт, детекция дрейфа,
RMS-огибающая, граф комнат (resolveComponents), per-clip синхронизация (runClipSync).

## Структура

- `client/shared/` — переиспользуемый движок (ES5, грузится и в CEP, и в Node):
  - `sync-core.js` — FFT + globalNccPeak (кросс-корреляция).
  - `sync-graph.js` — граф комнат, офсеты, компоненты связности.
  - `sync-runner.js` — `runClipSync` (per-clip синхронизация, модель Syncaila).
  - `audio-envelope.js` — ffmpeg → RMS-огибающая (кросс-платформенный поиск ffmpeg).
  - `fcpxml-transform.js` — парс/сборка FCP7 XML (секвенция _SYNCED, Rose-метки, pproTicks).
  - `bridge-premiere.js` — мост панель↔host (export/import).
- `client/panel/` — UI (index.html, panel.js, styles.css).
- `host/premiere-sync.jsx` — ExtendScript-host (`$._SYNC_`): export + import.
- `standalone/` — CLI поверх того же движка (`sync-xml.mjs`, `load-dsp.mjs`).
- `tests/` — юнит-тесты (`npm test`).
- `tools/cep-debug.mjs` — CDP-драйвер для live-отладки.

## Документы

- Спецификация: `docs/superpowers/specs/2026-06-16-ai-sync-plugin-design.md`
- План реализации: `docs/superpowers/plans/2026-06-16-ai-sync-plugin.md`
