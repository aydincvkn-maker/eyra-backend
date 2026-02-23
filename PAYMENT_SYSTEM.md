# EYRA Payment System (Sandbox)

Bu doküman, backend'e eklenen ödeme altyapısının güvenli şekilde nasıl kurulup test edileceğini anlatır.

## 1) Özellikler

- Kart ve kripto yöntemi seçimi (`method: card | crypto`)
- Backend ürün kataloğu (`productCode`)
- Idempotency desteği (`idempotencyKey`)
- Webhook imza doğrulama (`x-eyra-signature`)
- Webhook event deduplication (`eventId` unique)
- Durum akışı: `created -> pending -> paid/failed -> refunded`
- Coin topup ve VIP satın alma etkileri

## 2) Env Ayarları

`.env` içine ekleyin:

```dotenv
PAYMENT_PROVIDER=mock
PAYMENT_WEBHOOK_SECRET=CHANGE_THIS_WEBHOOK_SECRET
PAYMENT_SUCCESS_URL=eyra://payment/success
PAYMENT_CANCEL_URL=eyra://payment/cancel
```

## 3) Endpointler

### Public

- `GET /api/payments/catalog`
- `POST /api/payments/webhook`
- `GET /api/payments/mock-checkout`
- `GET /api/payments/mock-complete`

### Auth Required

- `POST /api/payments/intents`
- `GET /api/payments/me`
- `GET /api/payments/:orderId`
- `POST /api/payments/:orderId/confirm`

### Admin Permission (`finance:view`)

- `POST /api/payments/:orderId/refund`

## 4) Akış (Sandbox E2E)

1. Katalogu çek: `GET /api/payments/catalog`
2. Intent oluştur:

```json
POST /api/payments/intents
{
  "productCode": "coin_1000_try",
  "method": "card",
  "idempotencyKey": "user123-order1"
}
```

3. Dönen `payment.providerCheckoutUrl` adresini aç.
4. Mock checkout ekranından başarılı/başarısız tamamla.
5. Durumu doğrula: `GET /api/payments/:orderId`
6. Kullanıcı coin değişimini doğrula (`Transaction type: purchase`).

### Stripe Notu

- `PAYMENT_PROVIDER=stripe` iken kart ödemeleri Stripe Checkout ile açılır.
- Mobil uygulama checkout sonrası `POST /api/payments/:orderId/confirm` çağırarak
  stripe session durumunu backend'de doğrular ve ödeme `paid` ise etkiler uygulanır.
- Kripto method seçimi şu an sandbox `mock` provider üzerinden çalışır.

## 5) Webhook Güvenliği

Header:

- `x-eyra-signature`: HMAC SHA256

İmza string formatı:

`eventId.providerPaymentId.status.amountMinor`

Status destekleri:

- `paid`
- `failed`
- `refunded`

## 6) Üretime Geçiş Notu

- `mock` provider yerine gerçek PSP adapter yazılmalı.
- PSP callback URL: `/api/payments/webhook`
- Kart verisi backend'de tutulmamalı (PCI scope azaltma).
- Günlük mutabakat job'u (PSP vs DB) ayrı cron olarak eklenmeli.

## 7) Stripe Dashboard + Production Env (Adım adım)

### Backend `.env` (production)

```dotenv
PAYMENT_PROVIDER=stripe
PAYMENT_WEBHOOK_SECRET=unused_for_stripe
PAYMENT_SUCCESS_URL=eyra://payment/success
PAYMENT_CANCEL_URL=eyra://payment/cancel
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Tam şablon için: `.env.production.example`

Not: `PAYMENT_PROVIDER=stripe` iken kart ödemeleri Stripe üzerinden açılır, `crypto` method seçimi mock akışta kalır.

### Stripe Dashboard ayarları

1. `Developers -> API keys` içinden live `Secret key` alın ve `STRIPE_SECRET_KEY` olarak backend'e girin.
2. `Developers -> Webhooks -> Add endpoint`:
   - URL: `https://YOUR_BACKEND_DOMAIN/api/payments/webhook?provider=stripe`
   - Events:
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `checkout.session.async_payment_failed`
3. Oluşan endpoint için `Signing secret (whsec...)` değerini alın ve `STRIPE_WEBHOOK_SECRET` olarak backend'e girin.

### Redirect URL ayarları

- `PAYMENT_SUCCESS_URL` ve `PAYMENT_CANCEL_URL` mobil deep link (`eyra://...`) veya web URL olabilir.
- Mobilde deep link kullanılmıyorsa uygulama polling ile `POST /api/payments/:orderId/confirm` çağırarak sonucu doğrular.

### Canlı smoke test

1. Uygulamada kart yöntemiyle intent oluştur.
2. Stripe checkout'u tamamla.
3. Backend'de ödeme `paid` ve kullanıcı coin/vip etkisi işlendiğini doğrula.
4. `payment_events` içinde Stripe event kaydının tekil işlendiğini kontrol et.

## 8) Otomasyon Komutları

Backend klasöründe:

```bash
npm run payments:validate
npm run payments:readiness
npm run payments:readiness:prod
npm run payments:smoke
```

`payments:smoke` için auth gerektiren adımların çalışması adına env set edebilirsin:

```bash
BACKEND_URL=https://YOUR_BACKEND
E2E_AUTH_TOKEN=BearerTokenWithoutPrefix
PAYMENT_METHOD=card
PAYMENT_PRODUCT_CODE=coin_1000_try
```
