# Домашний кинотеатр

Минимальный «онлайн-кинотеатр» для личной коллекции видео на USB-диске.

- **Сервер** (`server.js`, Node.js + Express): сканирует папку, отдаёт список видео,
  стримит файлы с поддержкой HTTP Range (перемотка работает), конвертирует `.srt` → WebVTT
  (включая файлы в cp1251), вход по паролю (подписанная HttpOnly-cookie, защита от перебора).
- **UI** (`web/`, React + Vite): библиотека по папкам, поиск, «Продолжить просмотр»,
  плеер с субтитрами, автопереход к следующей серии. Прогресс хранится в браузере.

Без транскодирования — браузер получает файл как есть (у Pi 5 нет аппаратного кодировщика).

## Какие файлы будут играть

| Формат | Браузеры |
|---|---|
| `.mp4` (H.264 + AAC) | везде, включая iPhone |
| `.webm` | Chrome, Firefox, Edge |
| `.mkv` (H.264) | Chrome/Edge обычно да; Safari/iPhone — нет |
| `.mkv`/`.mp4` с HEVC (H.265) | зависит от устройства |
| `.avi`, звук AC3/DTS | как правило, нет |

Проблемные файлы можно **перепаковать без перекодирования** (быстро, даже на Pi):

```bash
ffmpeg -i "Фильм.mkv" -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart "Фильм.mp4"
```

Если звук AC3/DTS — перекодировать только звук:

```bash
ffmpeg -i "Фильм.mkv" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -movflags +faststart "Фильм.mp4"
```

Субтитры: положите рядом `Фильм.srt` или `Фильм.ru.srt`, `Фильм.en.srt` — подхватятся автоматически.

## Установка на mediaserver

Нужен Node.js 18+. Выполнять по одной команде:

1. Скопировать проект в `/opt/home-cinema` (например, `scp -r home-cinema pi@mediaserver:/tmp/` и затем `sudo mv /tmp/home-cinema /opt/`).
2. `cd /opt/home-cinema`
3. `npm install`
4. `npm run build`
5. `cp .env.example .env` и отредактировать: `MEDIA_ROOT`, `CINEMA_PASSWORD`, `CINEMA_SECRET` (`openssl rand -hex 32`).
6. Проверка вручную: `set -a; . ./.env; set +a; node server.js` → открыть `http://192.168.50.5:8090`.
7. `sudo cp deploy/home-cinema.service /etc/systemd/system/` (поправьте `User=` при необходимости).
8. `sudo systemctl enable --now home-cinema`

## Доступ извне через EC2

Пример конфигурации nginx — `deploy/nginx-ec2.conf`: домен → WireGuard-IP mediaserver, порт 8090,
с выключенной буферизацией. HTTPS обязателен (certbot), иначе пароль идёт открытым текстом.

⚠️ Весь трафик пойдёт через EC2, а исходящий трафик AWS платный сверх бесплатного лимита —
фильм на 4 ГБ ≈ 4 ГБ трафика. Альтернатива без этих затрат: подключать телефон/ноутбук к
WireGuard и открывать `http://<wg-ip-mediaserver>:8090` напрямую.

Скорость: для 1080p нужен upload домашнего интернета ~8–15 Мбит/с на один поток.

## Разработка

```bash
npm start          # API на :8090 (нужны MEDIA_ROOT и CINEMA_PASSWORD в окружении)
npm run dev:web    # UI с hot reload на :5173, /api проксируется на :8090
```

## API

| Метод | Путь | |
|---|---|---|
| POST | `/api/login` | `{ "password": "..." }` → cookie |
| POST | `/api/logout` | |
| GET | `/api/videos` | список (`?refresh=1` — пересканировать) |
| GET | `/api/stream/:id` | видео, поддерживает `Range` |
| GET | `/api/subtitle/:id` | субтитры в WebVTT |

`id` — base64url относительного пути; выход за пределы `MEDIA_ROOT` блокируется.

## Идеи для развития

- Превью-кадры: `ffmpeg -ss 60 -i файл -frames:v 1 -vf scale=320:-1 thumb.jpg` в фоне, с кешем.
- Постеры и описания из TMDB.
- HLS-транскодирование для «неиграющих» форматов (на Pi 5 только программно и медленно).
