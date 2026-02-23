# PAYMENT GO-LIVE CHECKLIST (Pass/Fail)

Tarih: ____ / ____ / ______

Sorumlu: __________________

Ortam: `staging` / `production`

## A) Konfigürasyon

| Kontrol | Sonuç (Pass/Fail) | Not |
|---|---|---|
| `PAYMENT_PROVIDER` doğru (`stripe` veya `mock`) |  |  |
| `PAYMENT_SUCCESS_URL` ve `PAYMENT_CANCEL_URL` doğru |  |  |
| `stripe` ise `STRIPE_SECRET_KEY` set |  |  |
| `stripe` ise `STRIPE_WEBHOOK_SECRET` set |  |  |
| `mock` ise `PAYMENT_WEBHOOK_SECRET` set |  |  |

## B) Stripe Dashboard

| Kontrol | Sonuç (Pass/Fail) | Not |
|---|---|---|
| Webhook URL doğru (`/api/payments/webhook?provider=stripe`) |  |  |
| Event: `checkout.session.completed` seçili |  |  |
| Event: `checkout.session.expired` seçili |  |  |
| Event: `checkout.session.async_payment_failed` seçili |  |  |

## C) Uygulama Akışı

| Kontrol | Sonuç (Pass/Fail) | Not |
|---|---|---|
| Katalog endpoint yanıt veriyor |  |  |
| Kartla ödeme başlatma (`intents`) başarılı |  |  |
| Checkout sonrası `confirm` ile durum güncelleniyor |  |  |
| Başarılı ödemede `status=paid` |  |  |
| Başarılı ödemede coin/VIP etkisi doğru |  |  |
| `transactions` kaydı tekil oluşuyor (double-credit yok) |  |  |
| İptal/expired durumda coin yazılmıyor |  |  |

## D) Operasyon

| Kontrol | Sonuç (Pass/Fail) | Not |
|---|---|---|
| Webhook 4xx/5xx alarmı aktif |  |  |
| Günlük ödeme mutabakat kontrolü planlı |  |  |
| Finans/Admin ödeme kayıtlarını görebiliyor |  |  |

## E) Rollback (Acil)

1. `PAYMENT_PROVIDER=mock` yap.
2. Backend redeploy et.
3. Stripe webhook endpoint'ini geçici disable et.
4. `pending` siparişleri `confirm` ile reconcile et.
5. Gerekirse manuel düzeltme/iadeyi uygula.

Karar: `GO` / `NO-GO`

İmza: __________________
