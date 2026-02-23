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
