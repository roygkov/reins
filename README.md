# reins

Универсальный харнес для работы агента: ядро (контур, политика, журнал, крафт), контракты
(манифест, проверка, коннектор, клиент, память) и пакеты (организация, проект, человек).

Состояние: спецификация в схемах и три контракта в коде (манифест, журнал, политика) gate для команд оболочки, чтение пакетов, исполнение задачи и проверка готовности. Проверка вида «сверка цитат» входит в ядро. Для видов `command`, `artifact` и `external` ядро запускает скрипт проверки из пакета. Итог вида `human` принимает человек. Клиент: команда `reins` для пути сценария и плагин Claude Code с хуками событий сессии и скиллами памяти.

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
- `src/gate`: решение по команде оболочки. Модули `agentic` v0.5.8 без изменения логики и связка с политикой.
- `src/packs/packs.ts`: чтение пакетов с диска и слияние трёх уровней.
- `examples/packs`: пример пакетов организации, проекта и человека.
- `src/core`: автомат задачи, запуск скрипта сбора, хранение задачи на диске.
- `src/check/citations.ts`: проверка готовности вида «сверка цитат».
- `src/cli.ts`, `src/client`: команда `reins` и вход задачи для модели.
- `clients/claude-code`: команда `/reins:run` для Claude Code.
- `clients/claude-code/skills`: скиллы памяти харнеса: `search-first`, `decision-hygiene`, `strategic-compact`, `systematic-debugging`. Клиент называет их `reins:<имя>`. После правки скилла подними `version` в `plugin.json` и запусти `claude plugin update reins@reins`.
- `src/journal/writer.ts`: запись и чтение журнала.
- `test/data/*.json`: тестовые случаи как данные.
- `docs/contracts.md`: отличия кода от схем.

Нужен Node.js 23.6 или новее. Код запускается без сборки.

    npm install
    npm test

## Запуск сценария

Конфигурация `~/.config/reins/config.json`:

    {"packs": {"organization": "/путь/organization", "person": "/путь/person"}}

Команда (ссылка `~/.local/bin/reins` на `src/cli.ts`):

    reins scenarios
    reins open <сценарий> имя=значение
    reins report <задача> <файл>
    reins finish <задача>
    reins stop <задача>
    reins dispute <задача>
    reins dispute <задача> fail
    reins probes
    reins tasks
    reins status [days] [project=here|<project>]
    reins metrics [days=N] [step=hour|day|week] [project=here|<project>]
    reins memory
    reins memory census
    reins craft
    reins sweep

Claude Code: `claude --plugin-dir ~/IdeaProjects/reins/clients/claude-code`, затем `/reins:run <сценарий> имя=значение`.

Постоянная установка, в том числе для приложения Claude на рабочем столе:

1. Добавь в `~/.config/reins/config.json` ключ `"source"` с абсолютным путём к этому репозиторию. Клиент копирует в свой кэш только папку плагина: вход хука берёт ядро из `source`.
2. `claude plugin marketplace add ~/IdeaProjects/reins`
3. `claude plugin install reins@reins`

Адаптер и ядро копия берёт из `source` при каждом вызове. Сам вход `hooks/hook.ts` и файл `hooks/hooks.json` в копии не меняются: после их правки подними `version` в `plugin.json` и запусти `claude plugin update reins@reins`.

Старт сессии сверяет копию плагина у клиента с плагином в этом репозитории: версию и файлы `hooks/hook.ts` и `hooks/hooks.json`. При отличии первая строка контекста сессии называет обе версии и команду обновления.

Без ключа `source` установленная копия на каждое действие задаёт вопрос «the adapter did not start».

Плагин регистрирует хук перед каждым инструментом. Вместе с плагином `agentic` вопросы о записи удваиваются: барьеры должен держать один из двух.

## Графики мер

Стенд `examples/grafana` показывает ряды `reins metrics` в локальной Grafana. Ядро о стенде не знает: источник это журнал, хранилище стенда это его копия. Оба порта слушают только `127.0.0.1`.

    docker compose -f examples/grafana/docker-compose.yml up -d
    node examples/grafana/export.ts [days=90] [project=here|<project>]

Дашборд: `http://127.0.0.1:3000/d/reins`. Экспорт сначала запускает `reins probes`: запуск пишет числа барьера в журнал. Экспорт удаляет ряды `reins_*` проекта из хранилища и пишет окно заново. Экспорт отклоняет адрес хранилища не на этой машине. Дашборд правь в файле `examples/grafana/dashboards/reins.json`. Пороги мер задаёт раздел `targets` пакета: дашборд, `reins status`, сводка недели и крафт читают одни числа.

Экспорт по расписанию на macOS: `examples/grafana/schedule.sh install` ставит задачу launchd, которая запускает экспорт раз в час. `schedule.sh remove` снимает её, `schedule.sh status` показывает состояние. Журнал запусков: `~/Library/Logs/reins-measures-export.log`.

## Правка схем

Правь генератор, не файлы `.drawio`. Источник схем один: генератор; файлы `.drawio` это его вывод. PDF в репозитории нет.

    PYTHONIOENCODING=utf-8 python3 -I tools/gen_harness_diagrams.py docs/spec

## Решения

- Язык ядра: TypeScript на Node.js, без внешних зависимостей npm.
- Тестовые случаи политики хранятся как данные JSON.
- Источники переноса: `agentic` (политика, журнал, проверка, адаптер клиента) и `exocortex` (память).
