# Как загрузить MOTOR.BY на GitHub и развернуть на Render

Ниже — пошаговая инструкция для человека без опыта деплоя. Проект уже содержит `render.yaml`, поэтому рекомендуемый способ — **Render Blueprint**.

Официальные справки:

- GitHub: <https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github>
- Render Blueprints: <https://render.com/docs/infrastructure-as-code>
- Render Health Checks: <https://render.com/docs/health-checks>

---

## 1. Что понадобится

1. Аккаунт на <https://github.com>.
2. Аккаунт на <https://render.com>.
3. Архив `motor-by-site.zip` из этой сборки.
4. Для варианта с командами — установленный Git: <https://git-scm.com/downloads>.

API-ключи для автомобильных источников не нужны.

---

## 2. Подготовьте файлы

1. Скачайте `motor-by-site.zip`.
2. Полностью распакуйте архив в отдельную папку, например `motor-by-site`.
3. Откройте эту папку и проверьте структуру:

```text
motor-by-site/
├── server.js
├── index.html
├── package.json
├── package-lock.json
├── render.yaml
├── README.md
├── DEPLOY-GITHUB-RENDER.md
├── .gitignore
└── assets/
    ├── hero-car.jpg
    └── category-city.jpg
```

### Важно

На GitHub нужно загрузить **содержимое распакованной папки**, а не один ZIP-файл. `package.json` и `render.yaml` должны находиться в корне репозитория, а не внутри дополнительной вложенной папки.

Правильно:

```text
github.com/USER/motor-by/server.js
github.com/USER/motor-by/render.yaml
```

Неправильно:

```text
github.com/USER/motor-by/motor-by-site/server.js
```

---

## 3. Создайте репозиторий GitHub

1. Войдите на <https://github.com>.
2. Нажмите **+** в правом верхнем углу.
3. Выберите **New repository**.
4. В поле **Repository name** укажите, например:

```text
motor-by
```

5. Выберите видимость:
   - **Public** — проще подключить к Render;
   - **Private** — тоже работает, но Render нужно предоставить доступ к репозиторию.
6. Если будете использовать команды Git, не включайте автоматическое создание README, `.gitignore` или License: эти файлы уже есть в проекте.
7. Нажмите **Create repository**.

---

## 4. Загрузите проект на GitHub

Есть два способа. Выберите только один.

### Способ A — через сайт GitHub

1. Откройте созданный пустой репозиторий.
2. Нажмите ссылку **uploading an existing file** или **Add file → Upload files**.
3. Перетащите в область загрузки всё содержимое распакованной папки:
   - основные файлы;
   - папку `assets` вместе с четырьмя изображениями.
4. Убедитесь, что `server.js`, `index.html`, `package.json` и `render.yaml` находятся на верхнем уровне.
5. В поле сообщения коммита напишите:

```text
Initial MOTOR.BY deploy
```

6. Выберите **Commit directly to the main branch**.
7. Нажмите **Commit changes**.

После загрузки откройте папку `assets` на GitHub и убедитесь, что внутри есть два JPG-файла: `hero-car.jpg` и `category-city.jpg`.

### Способ B — через Git в терминале

Откройте терминал в распакованной папке проекта и выполните:

```bash
git init -b main
git add .
git commit -m "Initial MOTOR.BY deploy"
git remote add origin https://github.com/ВАШ_ЛОГИН/motor-by.git
git push -u origin main
```

Замените `ВАШ_ЛОГИН` своим именем пользователя GitHub.

Если Git просит имя и email перед первым коммитом:

```bash
git config --global user.name "Ваше имя"
git config --global user.email "ваш-email@example.com"
```

GitHub не принимает пароль аккаунта как пароль для Git. При необходимости используйте вход через браузер, GitHub Desktop, SSH или Personal Access Token.

После отправки обновите страницу репозитория и проверьте, что файлы появились в ветке `main`.

---

## 5. Подключите GitHub к Render

1. Войдите на <https://dashboard.render.com>.
2. Нажмите **New → Blueprint**.
3. Если GitHub ещё не подключён, нажмите подключение GitHub и разрешите Render доступ:
   - ко всем репозиториям; или
   - только к репозиторию `motor-by`.
4. Найдите репозиторий `motor-by` и нажмите **Connect**.
5. В форме Blueprint укажите:
   - **Blueprint Name**: например `motor-by`;
   - **Branch**: `main`;
   - **Blueprint Path**: `render.yaml` или оставьте значение по умолчанию.
6. Render покажет создаваемый Web Service. Проверьте основные значения:

```text
Service type: Web Service
Runtime: Node
Build command: npm install --omit=dev
Start command: npm start
Health check: /api/health
```

7. Нажмите **Deploy Blueprint**.
8. Дождитесь завершения сборки и запуска.

В логах запуска должна появиться строка примерно такого вида:

```text
Motor BY listening on 0.0.0.0:10000
```

Render сам передаёт порт через переменную `PORT`; вручную указывать порт не нужно.

После успешного деплоя Render покажет адрес примерно такого вида:

```text
https://motor-by.onrender.com
```

Если имя уже занято, Render добавит суффикс или предложит другое имя.

---

## 6. Проверьте сайт после деплоя

Откройте:

```text
https://ВАШ-СЕРВИС.onrender.com
```

Затем проверьте health endpoint:

```text
https://ВАШ-СЕРВИС.onrender.com/api/health
```

Ожидаемый ответ содержит:

```json
{
  "status": "ok",
  "service": "motor-by",
  "adapters": {
    "onliner": "enabled",
    "kufar": "enabled",
    "av": "enabled",
    "dealer": "enabled",
    "autohouse": "enabled"
  }
}
```

После этого на главной странице:

1. выберите один или несколько источников;
2. нажмите **«Показать объявления»**;
3. проверьте фотографии;
4. раскройте **«Все данные»**;
5. откройте ссылку **«Оригинал»**.

Первый запуск бесплатного Web Service после периода бездействия может занимать больше времени, чем последующие запросы.

---

## 7. Альтернативный способ: создать Web Service вручную

Если Blueprint не используется:

1. В Render нажмите **New → Web Service**.
2. Подключите репозиторий `motor-by`.
3. Выберите ветку `main`.
4. Заполните:

| Поле Render | Значение |
|---|---|
| Language / Runtime | Node |
| Region | Frankfurt или ближайший доступный |
| Branch | `main` |
| Root Directory | оставить пустым |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instance type | Free для тестирования, если доступен |

5. В Environment добавьте:

```text
NODE_VERSION=20.18.1
NODE_ENV=production
SEARCH_CACHE_TTL=180
DETAIL_CACHE_TTL=600
CATALOG_CACHE_TTL=21600
AV_TAXONOMY_CACHE_TTL=43200
AV_SOURCE_TIMEOUT_MS=14000
```

6. Включите **Auto-Deploy** для ветки `main`.
7. Нажмите **Create Web Service**.

Blueprint уже содержит эти параметры, поэтому ручной способ нужен только как запасной.

---

## 8. Как публиковать обновления

После изменения файлов локально:

```bash
git add .
git commit -m "Update MOTOR.BY"
git push origin main
```

Поскольку в `render.yaml` установлено `autoDeploy: true`, Render автоматически запустит новый deploy после push в `main`.

Если файлы меняются через сайт GitHub:

1. откройте нужный файл;
2. нажмите кнопку редактирования;
3. сохраните через **Commit changes** в `main`;
4. дождитесь нового deploy в Render.

Ход обновления виден в Render в разделе **Events** или **Logs** сервиса.

---

## 9. Проверка на iPhone 13 mini

Интерфейс оптимизирован под CSS-ширину **375 px** и учитывает безопасные зоны экрана.

После деплоя:

1. откройте сайт в Safari на iPhone;
2. обновите страницу без старого кэша;
3. проверьте портретный и альбомный режимы;
4. проверьте поля формы — Safari не должен увеличивать страницу при фокусе;
5. проверьте кнопки, карточки, галерею и нижнюю безопасную зону.

При добавлении сайта на домашний экран используются настройки `viewport-fit=cover` и безопасные отступы для выреза и индикатора Home.

---

## 10. Частые проблемы

### Render пишет, что `render.yaml` не найден

Файл оказался во вложенной папке. Переместите `render.yaml`, `package.json`, `server.js` и `index.html` в корень репозитория.

### Создан Static Site, но поиск не работает

Удалите Static Site и создайте **Web Service** или **Blueprint**. Проекту нужен Node backend для запросов к источникам.

### В логах `Cannot find package.json`

Проверьте Root Directory. Если файлы находятся в корне репозитория, поле должно быть пустым.

### Render не видит приватный репозиторий

В настройках GitHub App для Render предоставьте доступ к `motor-by`, затем обновите список репозиториев в Render.

### Главная открывается, но один источник показывает ошибку

Это не обязательно ошибка деплоя. Внешняя площадка может временно блокировать запросы или изменить формат. Проверьте:

```text
/api/health
```

и статусы источников на главной странице. Другие адаптеры продолжат работать независимо.

### После push ничего не обновилось

1. Убедитесь, что push попал в ветку `main`.
2. Откройте Render → сервис → **Settings**.
3. Проверьте, что Auto-Deploy включён для `main`.
4. При необходимости нажмите **Manual Deploy → Deploy latest commit**.

### Сайт долго открывается после паузы

Бесплатный экземпляр Render может переходить в спящий режим. Дождитесь запуска и повторно откройте страницу.

---

## 11. Безопасность

- Не добавляйте в GitHub файлы `.env`, пароли, токены или GitHub credentials.
- Проект не требует секретов автомобильных площадок.
- Для приватного репозитория выдавайте Render доступ только к нужному репозиторию.
- Перед публичным коммерческим использованием проверьте правила и условия источников объявлений.
