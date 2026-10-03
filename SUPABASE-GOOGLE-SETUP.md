# MOTOR.BY 1.9.0 — Google-вход и синхронизация через Supabase

Эта настройка выполняется полностью через браузер. Терминал не нужен.

## Что получится

- вход только через Google;
- отдельная приватная облачная строка для каждого пользователя;
- синхронизация избранного, сравнения, заметок, истории, сохранённых фильтров и настроек;
- восстановление данных после входа на другом телефоне или компьютере;
- локальная IndexedDB-копия для быстрого интерфейса и офлайн-просмотра;
- после выхода локальные личные данные очищаются с устройства.

## 1. Создайте проект Supabase

1. Откройте <https://supabase.com/dashboard>.
2. Нажмите **New project**.
3. Выберите организацию, имя проекта и регион рядом с Render (для `frankfurt` подойдёт европейский регион).
4. Создайте надёжный пароль базы и сохраните его у себя. MOTOR.BY этот пароль не использует.
5. Дождитесь запуска проекта.

## 2. Создайте защищённую таблицу

1. В Supabase откройте **SQL Editor → New query**.
2. Откройте из архива файл `supabase/schema.sql`.
3. Скопируйте его целиком в SQL Editor.
4. Нажмите **Run**.
5. В **Table Editor** должна появиться таблица `motorby_user_state` с включённым RLS.

Не отключайте Row Level Security. Политики из файла разрешают пользователю читать, создавать, менять и удалять только строку, где `user_id` совпадает с его Supabase Auth ID.

## 3. Настройте Google OAuth

### В Supabase

1. Откройте **Authentication → Sign In / Providers → Google**.
2. Пока не включайте переключатель, но скопируйте показанный **Callback URL**. Он выглядит так:

   ```text
   https://ВАШ-PROJECT-REF.supabase.co/auth/v1/callback
   ```

### В Google Cloud

1. Откройте <https://console.cloud.google.com/>.
2. Создайте или выберите проект.
3. Откройте **Google Auth Platform** либо **APIs & Services → OAuth consent screen**.
4. Укажите название приложения `MOTOR.BY`, контактный email и аудиторию **External**.
5. Для тестового режима добавьте свой Google-аккаунт в **Test users**.
6. Откройте **Credentials → Create credentials → OAuth client ID**.
7. Тип приложения: **Web application**.
8. В **Authorized JavaScript origins** добавьте:

   ```text
   https://avtopodbor-rb.onrender.com
   ```

9. В **Authorized redirect URIs** вставьте Callback URL из Supabase:

   ```text
   https://ВАШ-PROJECT-REF.supabase.co/auth/v1/callback
   ```

10. Создайте credential и скопируйте **Client ID** и **Client Secret**.

### Снова в Supabase

1. Вернитесь в **Authentication → Sign In / Providers → Google**.
2. Вставьте Google Client ID и Client Secret.
3. Включите Google provider и нажмите **Save**.
4. Google Client Secret храните только в Supabase. Не добавляйте его в GitHub, Render или HTML.

## 4. Разрешите возврат на MOTOR.BY

В Supabase откройте **Authentication → URL Configuration**:

- **Site URL**:

  ```text
  https://avtopodbor-rb.onrender.com
  ```

- **Redirect URLs** — добавьте:

  ```text
  https://avtopodbor-rb.onrender.com/
  ```

Если позже подключите собственный домен, добавьте и его точный HTTPS-адрес в Site URL/Redirect URLs и в Google Authorized JavaScript origins.

## 5. Подключите Supabase к Render

1. В Supabase откройте **Project Settings → API** или кнопку **Connect**.
2. Скопируйте:
   - **Project URL**;
   - **Publishable key** либо прежний **anon public key**.
3. В Render откройте сервис MOTOR.BY → **Environment**.
4. Добавьте:

   ```text
   SUPABASE_URL=https://ВАШ-PROJECT-REF.supabase.co
   SUPABASE_ANON_KEY=ВАШ_PUBLISHABLE_ИЛИ_ANON_KEY
   ```

5. Сохраните переменные и выполните **Manual Deploy → Deploy latest commit**.

`SUPABASE_ANON_KEY` является браузерным публичным ключом. Безопасность пользовательских строк обеспечивает RLS. Никогда не используйте в этом поле `service_role`/secret key.

## 6. Проверьте

1. Откройте:

   ```text
   https://avtopodbor-rb.onrender.com/api/account-config
   ```

   Должно быть `"enabled": true`.
2. На главной нажмите **«Войти»**.
3. Выберите тестовый Google-аккаунт.
4. Добавьте автомобиль в избранное, сравнение, заметку и сохранённый фильтр.
5. Подождите 2–3 секунды: у кнопки аккаунта должна появиться отметка актуальной облачной копии.
6. Откройте сайт в другом браузере/телефоне и войдите тем же Google-аккаунтом — облачная копия автоматически заменит локальную.
7. В Supabase → **Table Editor → motorby_user_state** должна быть одна строка этого пользователя.

## Важное поведение

- Если облачная строка уже существует, после входа она считается основной и заменяет локальные данные.
- Если пользователь входит впервые и строки ещё нет, текущие локальные данные становятся первой облачной копией, чтобы не потерять ранее сохранённое.
- Автосохранение срабатывает примерно через 1,8 секунды после изменения.
- При возвращении на вкладку через пять минут сайт проверяет облачную копию снова.
- Одновременное редактирование на двух устройствах разрешается по принципу «последняя успешная запись».
- Выход сначала сохраняет изменения, затем очищает личные данные из IndexedDB этого устройства. Облачная строка остаётся в аккаунте.
