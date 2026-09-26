# MOTOR.BY — Cloudflare Worker для поддержания Render Free

Worker раз в 10 минут отправляет обычный `GET` на публичный `/api/health` сервиса MOTOR.BY. Интервал меньше 15-минутного окна без входящего трафика у Render Free.

## Быстрый деплой

1. Проверьте URL в `wrangler.toml`:

   ```toml
   RENDER_HEALTH_URL = "https://avtopodbor-rb.onrender.com/api/health"
   ```

2. В терминале из этой папки выполните:

   ```bash
   npx wrangler login
   npx wrangler deploy
   ```

3. Подождите до 15 минут: Cloudflare предупреждает, что изменения Cron Trigger распространяются не мгновенно.

4. Посмотрите выполнения:

   ```bash
   npx wrangler tail
   ```

   В журнале должен появляться JSON с `"ok":true`, `"renderStatus":"ok"` и текущей версией MOTOR.BY.

## Проверка до публикации

```bash
npx wrangler dev
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

Публичный HTTP-маршрут самого Worker возвращает только его состояние и специально не пингует Render, поэтому посторонние посетители не могут создавать дополнительные wake-запросы.

## Важно

- Это практичный бесплатный обход холодного запуска, но не SLA: Cloudflare может задержать отдельный Cron Trigger, а Render вправе перезапускать Free-инстанс.
- Один запуск каждые 10 минут — 144 Worker-запроса в сутки.
- Постоянно работающий Render Free расходует почти весь месячный лимит Free instance hours. Если в workspace есть другие Free Web Services, часов может не хватить.
- Для гарантированного режима без сна используйте платный Render Starter или выше.
- Чтобы отключить пинги, удалите Cron Trigger в Cloudflare либо выполните `npx wrangler delete`.
