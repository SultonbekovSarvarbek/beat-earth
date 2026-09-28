# Beat Earth

Всемирный турнир на вылет в камень-ножницы-бумагу. Каждый раунд — случайный соперник из любой страны, проигравший выбывает, последний оставшийся становится чемпионом Земли.

- **Фронт:** Vite + React + TypeScript (`web/`), языки RU / EN / 中文
- **Бэк:** Supabase — Postgres, вход через Google, Realtime, pg_cron (`supabase/`)
- **Хостинг:** фронт и API-прокси на своём сервере (nginx), база и вход — Supabase Free

## Как устроена игра

| Правило | Как работает |
|---|---|
| Раунды | Все живые игроки случайно разбиваются на пары. Нечётный игрок проходит без матча. |
| Время на ход | `round_minutes` (по умолчанию 120 минут). Ходы запечатаны: соперник не видит твой ход, пока не сходит сам. |
| Не успел | Раз в минуту `tick()` доигрывает просроченные матчи: сначала ночная заготовка игрока (одна на раунд), иначе случайный ход. |
| Ничья | Переигровка. Если до дедлайна меньше 5 минут, он продлевается до 5 минут. |
| Финал | Когда живых ≤ `final_size` (16), матчи идут до 2 побед, на каждую игру `final_move_seconds` (120 с). Если задан `final_at`, финал ждёт этого времени (по умолчанию 13:00 UTC). |
| Следующий раунд | Открывается сразу, как только доигран последний матч раунда (или на ближайшем `tick()`). |

## Структура

```
supabase/
  migrations/20260928000000_init.sql   таблицы, RLS, логика игры, RPC
  migrations/20260928000100_cron.sql   запуск tick() каждую минуту
  seed.sql                             первый сезон
  tests/run-local.sh                   прогон целого сезона на локальном Postgres
web/
  src/App.tsx                          экраны: вход, регистрация, матч, победа/вылет, ночной режим
  src/api.ts                           вызовы Supabase
  src/i18n.ts                          тексты RU / EN / 中文
```

Клиент ничего не пишет в таблицы напрямую: RLS разрешает только чтение, а все действия идут через функции `join_season`, `submit_move`, `set_presets`. Чужие ходы до раскрытия прочитать нельзя.

## Запуск

### 1. Supabase

1. Создай проект на [supabase.com](https://supabase.com) (регион, например, Frankfurt).
2. **SQL Editor** → выполни по очереди `supabase/migrations/20260928000000_init.sql`, `supabase/migrations/20260928000100_cron.sql`, `supabase/seed.sql`.
   Или через CLI: `supabase link --project-ref <ref> && supabase db push`.
3. **Database → Publications → supabase_realtime**: проверь, что включены таблицы `matches`, `games`, `seasons` (миграция добавляет их сама, если публикация существует).

### 2. Вход через Google

1. [console.cloud.google.com](https://console.cloud.google.com) → новый проект → **Google Auth Platform**: тип External, доступы только `email`, `profile`, `openid`.
2. **Clients → Create client → Web application**. В *Authorized redirect URIs* вставь Callback URL из Supabase (**Authentication → Sign In / Providers → Google**), он выглядит как `https://<ref>.supabase.co/auth/v1/callback`.
3. Client ID и Client Secret вставь в Supabase в провайдер Google и включи его.
4. **Authentication → URL Configuration**: Site URL — адрес сайта; в Redirect URLs добавь `http://localhost:3000` и адрес сайта.

### 3. Фронт

```bash
cd web
cp .env.example .env.local   # впиши VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (Project Settings → API)
npm install
npm run dev                  # http://localhost:3000
```

### 4. Деплой на свой сервер

| Домен | Что там | Конфиг |
|---|---|---|
| `beat-earth.happybox.uz` | фронт (статические файлы из `web/dist`) | `deploy/nginx-front.conf` |
| `beat-earth-api.happybox.uz` | прокси на Supabase (REST, вход, Realtime) | `deploy/nginx-api.conf` |

Фронт в продакшене ходит на `https://beat-earth-api.happybox.uz` (`web/.env.production`), в разработке — напрямую на Supabase (`web/.env.development`).

**Установка и каждое обновление — одна команда на сервере (под root):**

```bash
curl -fsSL https://raw.githubusercontent.com/SultonbekovSarvarbek/beat-earth/main/deploy/setup-server.sh | bash
```

Скрипт забирает код в `/opt/beat-earth`, собирает фронт (с `--max-old-space-size=1536` для маленького сервера), выкладывает его в `/var/www/beat-earth`, ставит оба сайта в nginx (если их ещё нет), выпускает сертификаты Let's Encrypt и проверяет, что всё отвечает. Существующие сайты не трогает, перед перезагрузкой делает `nginx -t`.

**Cloudflare:** DNS-записи `beat-earth` и `beat-earth-api` должны указывать на IP сервера; режим SSL — **Full (strict)** (в режиме Flexible будет бесконечный редирект).

**Автодеплой при пуше в `main`** (`.github/workflows/deploy.yml`): в GitHub → Settings → Secrets and variables → Actions добавь `SSH_HOST` (IP сервера) и `SSH_KEY` (приватный ключ, публичная часть — в `/root/.ssh/authorized_keys`). Workflow заходит на сервер и запускает тот же скрипт.

**Проверка прокси:** `curl https://beat-earth-api.happybox.uz/auth/v1/health -H "apikey: <anon key>"` должен вернуть JSON.

В Supabase → Authentication → URL Configuration уже стоят Site URL `https://beat-earth.happybox.uz` и Redirect URL `https://beat-earth.happybox.uz/**`.

## Управление сезоном

```sql
-- новый сезон: старт через 3 дня в 12:00 UTC, финал через 5 дней в 13:00 UTC
insert into seasons (name, starts_at, final_at)
values ('Season 2', date_trunc('day', now()) + interval '3 days 12 hours',
                    date_trunc('day', now()) + interval '5 days 13 hours');

-- быстрый тестовый сезон: раунды по 2 минуты, без ожидания финала
insert into seasons (name, starts_at, round_minutes, final_at)
values ('Test', now() + interval '5 minutes', 2, null);

-- посмотреть состояние
select season_stats(1);
```

Сайт всегда показывает последний созданный сезон.

## Тесты

Прогон целого сезона (регистрация, ночные заготовки, ходы, авто-доигрывание, финал до 2 побед, проверка безопасности) на обычном Postgres 15+:

```bash
PGHOST=localhost PGUSER=postgres ./supabase/tests/run-local.sh 100000
```

Сезон на 100 000 игроков проходит локально примерно за минуту.

## Что дальше

- Невидимая капча Cloudflare Turnstile при регистрации и один аккаунт на устройство
- Проверка финалистов (топ-1000) через привязку Telegram
- Вход через Telegram и по коду на почту (для Китая, где Google заблокирован)
- Письма и пуши о начале раунда
