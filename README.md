# reins

Универсальный харнес для работы агента: ядро (контур, политика, журнал, крафт), контракты
(манифест, проверка, коннектор, клиент, память) и пакеты (организация, проект, человек).

Состояние: спецификация в схемах и три контракта в коде (манифест, журнал, политика) gate для команд оболочки, чтение пакетов, исполнение задачи и проверка вида «сверка цитат». Клиент: команда `reins` для пути сценария и хук «перед действием» для Claude Code. Остальных видов проверки ещё нет.

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
    reins tasks
    reins status [days] [project=here|<project>]
    reins metrics [days=N] [step=day|week] [project=here|<project>]
    reins memory
    reins craft
    reins sweep

Claude Code: `claude --plugin-dir ~/IdeaProjects/reins/clients/claude-code`, затем `/reins:run <сценарий> имя=значение`.

Постоянная установка, в том числе для приложения Claude на рабочем столе:

1. Добавь в `~/.config/reins/config.json` ключ `"source"` с абсолютным путём к этому репозиторию. Клиент копирует в свой кэш только папку плагина: вход хука берёт ядро из `source`.
2. `claude plugin marketplace add ~/IdeaProjects/reins`
3. `claude plugin install reins@reins`

Адаптер и ядро копия берёт из `source` при каждом вызове. Сам вход `hooks/hook.ts` и файл `hooks/hooks.json` в копии не меняются: после их правки подними `version` в `plugin.json` и запусти `claude plugin update reins@reins`.

Без ключа `source` установленная копия на каждое действие задаёт вопрос «the adapter did not start».

Плагин регистрирует хук перед каждым инструментом. Вместе с плагином `agentic` вопросы о записи удваиваются: барьеры должен держать один из двух.

## Правка схем

Правь генератор, не файлы `.drawio`. Источник схем один: генератор; файлы `.drawio` это его вывод. PDF в репозитории нет.

    PYTHONIOENCODING=utf-8 python3 -I tools/gen_harness_diagrams.py docs/spec

## Решения

- Язык ядра: TypeScript на Node.js, без внешних зависимостей npm.
- Тестовые случаи политики хранятся как данные JSON.
- Источники переноса: `agentic` (политика, журнал, проверка, адаптер клиента) и `exocortex` (память).
