# reins

Универсальный харнес для работы агента: ядро (контур, политика, журнал, крафт), контракты
(манифест, проверка, коннектор, клиент, память) и пакеты (организация, проект, человек).

Состояние: спецификация в схемах и код. В коде: контракты манифеста, журнала, политики и расписания; gate для команд оболочки; чтение пакетов; исполнение задачи и проверка готовности; очередь человека; триггеры по расписанию и по событию; запуск клиента без окна; память; крафт и сводка недели; меры журнала. Проверка вида «сверка цитат» входит в ядро. Для видов `command`, `artifact` и `external` ядро запускает скрипт проверки из пакета. Итог вида `human` принимает человек. Клиенты: команда `reins`, плагин Claude Code с хуками событий сессии и скиллами памяти, клиент `stdio`.

## Состав

- `docs/spec/harness-spec.*`: спецификация, 24 страницы. При расхождении верна она.
- `docs/spec/harness-overview.*`: карта модели, общие правила, словарь, открытые вопросы.
- `docs/spec/harness-<часть>.*`: детали по частям модели.
- `docs/spec/harness-instance-*.*`: пример экземпляра. В модель не входит.
- `tools/gen_harness_diagrams.py`: генератор всех файлов `.drawio`.
- `tools/mcp_share.py`: замер доли ответов MCP в транскриптах Claude Code. Запуск: `python3 -I tools/mcp_share.py <дни>`.

## Код

- `src/contracts/manifest.ts`: валидатор манифеста сценария.
- `src/contracts/journal.ts`: закрытый список событий и валидатор строки журнала.
- `src/contracts/policy.ts`: решение политики по слоям и конверту задачи.
- `src/contracts/schedule.ts`: форма триггера по расписанию.
- `src/contracts/shape.ts`: общие функции валидаторов.
- `src/gate`: решение по команде оболочки. Модули `agentic` v0.5.8 и связка с политикой. Одно отличие логики: список `words` формы `gate.forms` (`docs/contracts.md`, S7).
- `src/packs/packs.ts`: чтение пакетов с диска и слияние трёх уровней.
- `examples/packs`: пример пакетов организации, проекта и человека.
- `src/core`: автомат задачи, запуск скрипта сбора, хранение задачи на диске, очередь человека, триггеры, пауза, очистка по срокам.
- `src/check/citations.ts`: проверка готовности вида «сверка цитат».
- `src/cli.ts`, `src/client`: команда `reins`, вход задачи для модели, решение перед действием, события сессии, запуск клиента без окна, пробы барьера.
- `src/memory/store.ts`: память харнеса: записи, дела, решения.
- `src/craft`: крафт (`craft.ts`) и сводка недели (`weekly.ts`).
- `clients/claude-code`: плагин Claude Code: хуки событий сессии и команда `/reins:run`.
- `clients/stdio`: второй клиент: одно событие в JSON на стандартном входе, ответ ядра на стандартном выходе.
- `clients/claude-code/skills`: скиллы памяти харнеса: `search-first`, `decision-hygiene`, `strategic-compact`, `systematic-debugging`. Клиент называет их `reins:<имя>`. После правки скилла подними `version` в `plugin.json` и запусти `claude plugin update reins@reins`.
- `src/journal/writer.ts`: запись и чтение журнала.
- `src/journal/metrics.ts`: меры журнала для `reins status` и `reins metrics`.
- `test/data/*.json`: тестовые случаи как данные.
- `docs/contracts.md`: отличия кода от схем.

Нужен Node.js 23.6 или новее. Код запускается без сборки.

    npm install
    npm test

## Запуск сценария

Конфигурация `~/.config/reins/config.json`:

    {"packs": {"organization": "/путь/organization", "person": "/путь/person"}}

Переменная `REINS_CONFIG` задаёт другой файл. Список ключей закрыт: неизвестный ключ это ошибка `bad_config`.

| Ключ | Значение |
|---|---|
| `packs` | Обязательный. Абсолютные каталоги пакетов по уровням: `organization`, `project`, `person` |
| `source` | Абсолютный путь к этому репозиторию: вход хука берёт ядро отсюда |
| `state_dir` | Каталог состояния. Умолчание: `~/.local/state/reins` |
| `memory_dir` | Каталог записей памяти |
| `memory_commit` | `true`: харнес сам коммитит каталог памяти |
| `script_sandbox` | `true`: скрипты пакетов идут в песочнице системы (только macOS) |
| `repo_packs` | `true`: пакет проекта читается из `.reins` в корне репозитория |
| `runner` | Команда запуска клиента без окна, список слов. Слова `{task}`, `{prompt}`, `{model}` заполняет харнес |
| `runner_timeout_s` | Предел времени одного запуска клиента, секунды |
| `runner_parallel` | Сколько клиентов идёт сразу, от 1 до 8 |
| `check_timeout_s` | Предел времени скрипта проверки, секунды, от 1 до 86400 |
| `notify` | Команда уведомления, список слов. Слово `{text}` это текст |
| `markers`, `protected_branches`, `prod_hosts`, `prod_scripts`, `prod_fastlane_lanes`, `forms`, `rules` | Данные гейта: добавляются к встроенным (`src/gate/data/gate.json`) |
| `repos` | Данные гейта для одного репозитория: объект «ключ репозитория → те же ключи гейта» |
| `mcp_prod_servers`, `ignore` | Ключи принимаются. Ядро их не читает |

Переменные `REINS_HEADLESS` и `REINS_PROJECT` харнес ставит сам клиенту, который он запустил без окна. Вручную их не задавай.

Команда (ссылка `~/.local/bin/reins` на `src/cli.ts`). Команда без слов печатает этот список:

    reins scenarios
    reins packs
    reins open <сценарий> [имя=значение]
    reins match <значение>
    reins input <задача>
    reins check <задача> [файл|-]
    reins report <задача> <файл|->
    reins finish <задача>
    reins stop <задача>
    reins result <задача>
    reins tasks
    reins propose <contract.json>
    reins approve <задача>
    reins retry <задача>
    reins raise <задача>
    reins dispute <задача>
    reins dispute <задача> fail
    reins queue
    reins queue approve|reject <id>
    reins pause <минуты>
    reins probes
    reins sweep
    reins enable <сценарий>
    reins tick
    reins tick run
    reins timer [минуты]
    reins run <сценарий> [имя=значение]
    reins fire <событие> [имя=значение]
    reins fire run <событие> [имя=значение]
    reins status [days] [project=here|<project>]
    reins metrics [days=N] [step=hour|day|week] [project=here|<project>]
    reins week
    reins craft
    reins craft accept|reject <id>
    reins memory
    reins memory find <слово>...
    reins memory census
    reins memory show <id>
    reins memory next <дело> <шаг> task=<задача> [status=<s>]
    reins memory close <дело> task=<задача>
    reins memory step <дело> <шаг> [status=<s>]
    reins memory end <дело>
    reins memory add <тип> <текст> task=<задача> [path=<p>]
    reins memory decide <текст> because=<причина>
    reins memory veto <id>
    reins memory restore <id>
    reins memory share <id>
    reins memory wrong <id>
    reins memory import <файл>

Что делает каждая команда: `docs/contracts.md`.

Claude Code: `claude --plugin-dir ~/IdeaProjects/reins/clients/claude-code`, затем `/reins:run <сценарий> имя=значение`.

Постоянная установка, в том числе для приложения Claude на рабочем столе:

1. Добавь в `~/.config/reins/config.json` ключ `"source"` с абсолютным путём к этому репозиторию. Клиент копирует в свой кэш только папку плагина: вход хука берёт ядро из `source`.
2. `claude plugin marketplace add ~/IdeaProjects/reins`
3. `claude plugin install reins@reins`

Адаптер и ядро копия берёт из `source` при каждом вызове. Первый файл хука `hooks/start.mjs`, вход `hooks/hook.ts` и файл `hooks/hooks.json` в копии не меняются: после их правки подними `version` в `plugin.json` и запусти `claude plugin update reins@reins`.

Старт сессии сверяет копию плагина у клиента с плагином в этом репозитории: версию и файлы `hooks/start.mjs`, `hooks/hook.ts` и `hooks/hooks.json`. При отличии первая строка контекста сессии называет обе версии и команду обновления.

Без ключа `source` установленная копия на каждое действие задаёт вопрос «the adapter did not start».

Плагин регистрирует хук перед каждым инструментом. Вместе с плагином `agentic` вопросы о записи удваиваются: барьеры должен держать один из двух.

## Графики мер

Стенд `examples/grafana` показывает ряды `reins metrics` в локальной Grafana. Ядро о стенде не знает: источник это журнал, хранилище стенда это его копия. Оба порта слушают только `127.0.0.1`.

    docker compose -f examples/grafana/docker-compose.yml up -d
    node examples/grafana/export.ts [days=90] [url=http://127.0.0.1:8428] [project=here|<project>]

Дашборд: `http://127.0.0.1:3000/d/reins`. Экспорт сначала запускает `reins probes`: запуск пишет числа барьера в журнал. Экспорт удаляет ряды `reins_*` проекта из хранилища и пишет окно заново. Экспорт отклоняет адрес хранилища не на этой машине. Дашборд правь в файле `examples/grafana/dashboards/reins.json`. Пороги мер задаёт раздел `targets` пакета: дашборд, `reins status`, сводка недели и крафт читают одни числа.

Экспорт по расписанию на macOS: `examples/grafana/schedule.sh install` ставит задачу launchd, которая запускает экспорт раз в час. `schedule.sh remove` снимает её, `schedule.sh status` показывает состояние. Журнал запусков: `~/Library/Logs/reins-measures-export.log`.

## Правка схем

Правь генератор, не файлы `.drawio`. Источник схем один: генератор; файлы `.drawio` это его вывод. PDF в репозитории нет.

    PYTHONIOENCODING=utf-8 python3 -I tools/gen_harness_diagrams.py docs/spec

## Решения

- Язык ядра: TypeScript на Node.js, без внешних зависимостей npm.
- Тестовые случаи политики хранятся как данные JSON.
- Источники переноса: `agentic` (политика, журнал, проверка, адаптер клиента) и `exocortex` (память).
