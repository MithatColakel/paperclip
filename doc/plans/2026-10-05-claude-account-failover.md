# Şirket İçi Claude Hesap Havuzu ve Kota Devri

Tarih: 2026-10-05
Dal: `deploy/2026.1001.0`
Durum: Faz 1, 2 ve 4 kodlandı (`deploy/2026.1001.0`, commit edilmedi); Faz 0
yayın hattı hazırlandı, sunucuya uygulanmadı; Faz 3 kullanıcı kurulumunu bekliyor

## Amaç

Her Paperclip şirketi (organizasyon) kendine ait birden fazla Claude hesabını
sıralı bir havuz olarak kullanabilsin. Bir hesabın kotası dolduğunda run, aynı
şirketin sıradaki hesabıyla hemen devam etsin. Dolan hesap sıfırlanma saatine
kadar atlansın ve sonra kendiliğinden havuza geri dönsün.

## Kararlar

1. **Geçiş yalnızca şirket içinde olur.** Bir şirketin run'ı başka bir şirketin
   hesabını hiçbir koşulda kullanmaz. Havuz kayıtları şirkete bağlıdır ve sunucu
   bunu her seçimde zorunlu kılar.
2. **Hangi Mac'te çalışılacağı ile hangi hesabın kullanılacağı birbirinden
   bağımsızdır.** Mac seçimi bugünkü gibi agent'ın ortamıyla
   (`defaultEnvironmentId`) yapılır; Apple hesabı ve imza o Mac'te kalır. Claude
   hesabı Paperclip'ten run başına enjekte edilir. Kota devri Mac'i değiştirmez.
3. **Hesaplar Paperclip'te tutulur, Mac'lerde değil.** Her hesap için
   `claude setup-token` ile alınan uzun ömürlü token, mevcut "AI connections"
   altyapısında şirket genelinde paylaşılan bağlantı olarak saklanır.
   Token'ları board kullanıcısı arayüzden girer.
4. **Mevcut altyapı genişletilir, yenisi yazılmaz.** Kota algılama
   (`provider_quota` ve `retryNotBefore`), hesap seçimi
   (`aiConnectionService.select`) ve izole kimlik bilgisi enjeksiyonu
   (`prepareManagedAiRuntime`) zaten var. Eksik olan yalnızca aday listesi,
   hesap başına kota durumu ve hata sonrası başka hesaba geçiş.

## Bugünkü Durum (üretim, 2026-10-05)

| Şirket | Claude hesapları (bilinen) | Not |
|---|---|---|
| VPNProjects | Max `m***l@gmail` (MacBook Pro), Max `y***k@gmail` (Mac mini), Pro `b***v@icloud` (MacBook Air), sunucu token'ı (`claude_subscription_token` secret) | Linux runner ortamları sunucu token'ını kullanıyor |
| Cleanio | Max `e***h@gmail` (TECHNOGRADE MacBook Air) | Tek hesap — ikinci hesap eklenmezse devredecek hesap yok |
| SkyNet Labs | — | Aktif agent yok |

- Hiçbir agent'ta `runtimeConfig.aiConnection` tanımlı değil ve hiç AI
  connection yok. Kimlik bilgileri ortam `envVars` içindeki
  `CLAUDE_CODE_OAUTH_TOKEN` üzerinden ya da uzak makinenin kendi
  `~/.claude` girişinden geliyor.
- Mac'ler Mac Fleet sandbox sürücüsüyle değil, **SSH ortamlarıyla** bağlı
  (`bernamanavmac`, `mac-securezone`; host `10.114.0.2`). Mac SSH ortamlarında
  `CLAUDE_CODE_OAUTH_TOKEN` tanımlı değil.
- Bugün bir run (VPNProjects / TrelloIntake) `provider_quota` ile düştü ve
  `retryNotBefore=16:00` aldı. Mevcut davranışta run aynı hesapla 16:00'yı
  bekliyor.

## Tasarım

### 1. Hesap havuzu (yeni)

`packages/db/src/schema/ai_connection_pools.ts`:

```ts
ai_connection_pool_members (
  id uuid pk,
  company_id uuid not null -> companies (cascade),
  provider text not null,              -- "anthropic"
  connection_id uuid not null -> tool_connections (cascade),
  grant_id uuid not null -> connection_grants (cascade),
  priority integer not null,           -- küçük olan önce denenir
  created_at, updated_at,
  unique (company_id, provider, connection_id),
  unique (company_id, provider, priority)
)
```

- Yalnızca `grant.kind = "organization"` (şirket paylaşımlı) bağlantılar havuza
  girebilir.
- Ekleme sırasında bağlantının `company_id` değeri havuzun `company_id`
  değeriyle aynı olmalı; değilse 422 döner.

### 2. Hesap başına kota durumu (yeni)

`packages/db/src/schema/ai_connection_quota_states.ts`:

```ts
ai_connection_quota_states (
  company_id uuid not null -> companies (cascade),
  connection_id uuid not null -> tool_connections (cascade),
  exhausted_until timestamptz,         -- null = kullanılabilir
  reason text,                         -- "provider_quota" | "usage_threshold"
  source text not null,                -- "run_failure" | "usage_probe" | "manual"
  usage_checked_at timestamptz,        -- Faz 4: son kullanım sorgusu
  usage_windows jsonb,                 -- Faz 4: son sorgunun pencereleri (yüzde + resetsAt)
  last_run_id uuid,                    -- durumu tetikleyen run
  updated_at timestamptz not null,
  primary key (company_id, connection_id)
)
```

- Kota durumu bağlantı başına tutulur. Aynı hesap iki agent tarafından
  kullanılıyorsa ikisi de dolu bilgisini görür.
- Claude bir sıfırlanma saati verirse `exhausted_until = retryNotBefore` olur.
  Vermezse varsayılan **now + 60 dk** kullanılır (onaylandı). 60 dk temkinli
  bir değer: erken dönülürse bir run daha düşer ve süre tekrar uzar.
- `source` sütunu durumun neden yazıldığını gösterir. Faz 4'teki ön kontrol de
  aynı tabloya yazar.

### 3. Yeni bağlama modu: `company_pool`

`packages/shared/src/ai-connections.ts` — `aiConnectionBindingSchema`
birleşimine eklenecek:

```ts
z.object({ provider: aiProviderSchema, method: aiAuthMethodSchema, mode: z.literal("company_pool") }).strict()
```

- Agent "Şirket Claude havuzu" modunu seçer. Belirli bir hesaba sabitlenmez.
- `isAiConnectionCompatible`: `company_pool`, `responsible_user` gibi
  sağlayıcının bütün yöntemlerini kabul eder. Böylece havuzda abonelik ve API
  key birlikte durabilir.

### 4. Seçim

`server/src/services/ai-connections.ts` — `select()`:

- `company_pool` modunda havuz üyeleri `priority` sırasıyla okunur. Her aday
  için mevcut kontroller **aynen** uygulanır: sağlık durumu, grant durumu,
  insan erişimi (audience) ve agent kurulumu.
- `exhausted_until > now` olan adaylar atlanır.
- Kontrolden geçen ilk aday döner. `attribution` içine
  `mode: "company_pool"` ve `poolPriority` eklenir.
- Hiç uygun aday yoksa yeni hata kodu üretilir:
  `ai_connection_pool_exhausted { retryAt: min(exhausted_until) }`.

### 5. Run hazırlığı ve bekleme

`server/src/services/heartbeat.ts` (yaklaşık 21172–21228) —
`prepareManagedAiRuntime` hatası yakalanır:

- Hata `ai_connection_pool_exhausted` ise run **yapılandırma hatasına
  düşmez**. Mevcut `finalizeAiConnectionBusyDeferral` akışının benzeriyle
  `retryAt` zamanına kalıcı bir zamanlanmış tekrar kurulur.
  - Görev "Claude kotası dolu — HH:MM'de devam edecek" olarak görünür.
  - Bu bekleme sağlayıcı hata hakkından düşmez.

### 6. Kota hatasında devir

`heartbeat.ts`, run sonlandırma (yaklaşık 25118) ve `scheduleBoundedRetryForRun`:

1. Run `provider_quota` ile biter ve `contextSnapshot.aiConnection.mode ===
   "company_pool"` ise:
   - `ai_connection_quota_states` içine `connectionId` için
     `exhausted_until` yazılır (upsert; mevcut değerden daha geç olan kazanır).
   - Activity log kaydı (`ai_connection.quota_exhausted`) ve run log olayı
     eklenir.
2. Havuzda kullanılabilir başka bir aday varsa tekrar **hemen**
   (`delayMs: 0`) ve yeni bir neden koduyla (`ai_connection_failover`)
   kuyruğa alınır.
   - Bu tekrar, sınırlı geçici hata hakkını (2 deneme) **tüketmez**.
   - Sonsuz döngüye karşı run başına en fazla `havuz boyutu` kadar devir
     yapılır.
3. Uygun aday yoksa bugünkü davranış korunur: tekrar `min(exhausted_until)`
   zamanına kurulur.
4. Yeni hesap yeni bir kimlik demektir. Mevcut kural gereği ("changed identity
   starts a fresh provider session") Claude oturumu sıfırdan başlar; görev
   bağlamı Paperclip'in tam açılış mesajıyla tekrar verilir. Devam eden
   konuşmanın Claude tarafındaki geçmişi yeni hesaba taşınmaz.

### 7. Sıfırlanma

- Ayrı bir zamanlayıcı gerekmez. Seçim sırasında `exhausted_until <= now` olan
  aday zaten kullanılabilir sayılır.
- "Başarılı run işareti temizler" kuralı uygulanmadı: dolu işaretli hesap
  seçilmediği için onunla başarılı bir run da olamaz. Hesap tahminden erken
  sıfırlandıysa havuz kartındaki "Clear limit" ile elle açılır.

### 8. Arayüz

- **Şirket → Apps → AI hesapları:** Claude havuzu kartı.
  - Hesaplar sıralı liste olarak görünür, sıra yukarı/aşağı değiştirilir.
  - Her hesapta durum rozeti bulunur: "Kullanılabilir" veya "Kota dolu —
    16:00'ya kadar".
  - Hesap ekleme mevcut `AgentProviderConnection` / `AdapterLoginPanel`
    akışıyla yapılır. Erişim ayarı "şirketin tüm üyeleri" olarak seçilir.
- **Agent → Runtime → AI bağlantısı:** "Şirket Claude havuzu" seçeneği
  eklenir.
- **Run detayı:** Hangi hesapla çalıştığı (maskeli e-posta ve öncelik) ve devir
  olduysa önceki hesap gösterilir.
- Token-gate kuralları geçerlidir; `pnpm check:token-gates` çalıştırılır.

### 9. API

`/api/companies/:companyId/ai-connections/pool` (yalnızca board):

| Metot | İş |
|---|---|
| `GET` | Üyeler ve kota durumları |
| `PUT` | Sıralı üye listesini topluca değiştirir; activity log yazar |
| `POST /:connectionId/reset-quota` | "Doldu" işaretini elle kaldırır; activity log yazar |

Şirket erişim kontrolü, aktör izinleri ve 400/403/404/409/422 hataları mevcut
AI connection rotalarıyla aynı kalıpta olur.

## Ortamlar ve Mac'ler

- **SSH ortamları (bugünkü Mac bağlantısı):**
  - Yönetilen AI çalışma ortamı token'ı run env'i ile uzak tarafa iletir ve
    `CLAUDE_CONFIG_DIR` değerini özel bir dizine çevirir.
  - **Faz 0'da doğrulanacak:** macOS'ta SSH ile açılan oturumda keychain
    kilitli olduğu için `CLAUDE_CODE_OAUTH_TOKEN` ile çalışmanın sorunsuz
    olduğu (beklenen) ve ACP motorunun uzak auth dizinini SSH hedefinde
    kurduğu.
- **Linux runner ortamları** (`runner: vpn-*`):
  - Ortam `envVars` içindeki `CLAUDE_CODE_OAUTH_TOKEN`, yönetilen modda zaten
    temizleniyor (`stripAiAuthBindings`).
  - Havuza geçen agent'larda bu değişken ortamdan kaldırılacak; kaldırılmasa
    da etkisi olmaz.
- **Mac Fleet sürücüsü** (ileride kullanılırsa): Mac uygulaması
  (`CommandExecutor.swift`, `anthropicVars`) Mac'te kayıtlı token varsa
  sunucunun gönderdiği token'ı eziyor; bu, devri boşa düşürür. O sürücüye
  geçilirse Mac uygulamasında öncelik tersine çevrilecek: sunucu token
  gönderdiyse o kullanılacak. Bu değişiklik bu planın kapsamı dışında.

## Fazlar

### Faz 0 — Doğrulama ve yayın hattı (koddan önce)

1. **Yayın hattı.** `Dockerfile.patch` bugün yalnızca UI dist'ini, iki TS
   dosyasını ve `heartbeat.js` için bir dist yamasını resmi imajın üstüne
   koyuyor. Bu plan şunları değiştiriyor:
   - `packages/db` (yeni migration),
   - `packages/shared`,
   - `server` (derlenmiş dist),
   - `ui`.

   Tam derleme (repodaki `Dockerfile`) Rust runner'ı derliyor ve `@latest`
   CLI araçlarını kuruyor; 4 CPU / 8 GB sunucuda yavaş ve CLI sürümlerini
   istemeden değiştiriyor. **Karar: overlay genişletilir.** Fork, resmi imajın
   commit'inin (`8f8a0ab`) üstünde ve bağımlılıklar (`pnpm-lock.yaml`, bütün
   `package.json`'lar) değişmedi. Çalışma anında workspace paketleri
   `src/index.ts` üzerinden tsx ile yükleniyor, yalnızca sunucu `dist`'ten
   çalışıyor. Bu yüzden overlay şunları resmi imajın üstüne koyar:
   - `packages/**` kaynağı (`node_modules`, `dist` ve Rust runner hariç;
     migration'lar dahil),
   - `skills/`,
   - `tsc` ile derlenmiş `server/dist` ve onun kopyalanan varlıkları,
   - `ui/dist`.

   `build-patch.sh` önce resmi imajdaki `pnpm-lock.yaml` ile fork'unkini
   karşılaştırır; farklıysa durur (o durumda tam derleme gerekir). `heartbeat.js`
   dist yaması artık gerekmez, çünkü düzeltme kaynakta var ve sunucu yeniden
   derleniyor. Migration'lar sunucu açılışında otomatik uygulanır. Geri dönüş
   için `PAPERCLIP_IMAGE_ROLLBACK` ve `deploy-image.sh` aynen korunur.
2. **Migration geri dönüşü.** Yeni tablolar yalnızca eklemedir. Eski imaja
   dönülürse eski kod bu tabloları okumaz, yani geri dönüş güvenlidir.
3. **SSH Mac denemesi.** VPNProjects'te tek bir test agent'ı, bir Mac SSH
   ortamında mevcut `shared` modla bir AI connection kullanarak çalıştırılır.
   Token enjeksiyonu doğrulanır.

### Faz 1 — Sunucu ve sözleşmeler

- db şeması, migration (`pnpm db:generate`) ve dışa aktarımlar
- shared: bağlama modu, havuz ve kota tipleri, doğrulayıcılar, API yolları
- server: `select()`, havuz rotaları, hata sonrası devir, bekleme, activity log

### Faz 2 — Arayüz

- Havuz kartı, agent runtime seçeneği, run detayında hesap bilgisi

### Faz 3 — Kurulum (kullanıcı tarafı)

1. Her hesap için ilgili Mac'te (ya da herhangi bir terminalde o hesapla)
   `claude setup-token` çalıştırılır ve token Paperclip'te ilgili şirketin AI
   hesabı olarak eklenir.
2. Havuz sırası belirlenir. Örneğin VPNProjects için: Max → Max → sunucu Max →
   Pro. Pro'nun limiti düşük olduğu için en sona konur.
3. Agent'lar "Şirket Claude havuzu" moduna alınır.
4. Cleanio için ikinci bir hesap atanmadıkça devir olmaz; bu durumda run
   sıfırlanmayı bekler.

### Faz 4 — Kota dolmadan geçiş (ilk teslime dahil)

Kota dolduktan sonra devretmek run'ı yarıda keser. Bu faz, dolmak üzere olan
hesabı run başlamadan atlar.

- Mevcut `fetchClaudeQuota(token)` (`claude-local/src/server/quota.ts`)
  `api/oauth/usage` uç noktasını token başına sorgulayabiliyor; aynen yeniden
  kullanılır.
- Seçim sırasında, abonelik yöntemindeki her aday için son sorgu 5 dakikadan
  eskiyse kullanım sorgulanır. Sonuç `ai_connection_quota_states.usage_windows`
  alanına yazılır.
- **Eşik %95.** Değerlendirilen pencereler: 5 saatlik pencere, haftalık (tüm
  modeller) ve agent'ın modeline göre haftalık Opus/Sonnet penceresi. Eşiği
  geçen bir pencere varsa aday atlanır ve
  `exhausted_until = o pencerenin resetsAt` olur
  (`reason: "usage_threshold"`, `source: "usage_probe"`).
- Sorgu başarısız olursa (ağ hatası, 401/429) aday **engellenmez**. Gerçek kota
  hatası yine Faz 1'deki devirle yakalanır.
- Sorgu süresi 8 sn ile sınırlıdır (mevcut `fetchWithTimeout`), adaylar sırayla
  denenir ve ilk uygun aday bulununca durulur.
- API key yöntemindeki adaylar sorgulanmaz.
- Havuz kartında her hesabın son kullanım yüzdeleri ve sıfırlanma saatleri
  gösterilir.

## Testler

- `select()`:
  - öncelik sırası,
  - dolu adayın atlanması,
  - sağlıksız adayın atlanması,
  - hepsi dolu → `ai_connection_pool_exhausted` ve doğru `retryAt`,
  - başka şirketin bağlantısının havuza eklenememesi (403/422).
- heartbeat:
  - `provider_quota` → kota durumu yazılır, sıradaki hesapla hemen tekrar
    kurulur ve geçici hata hakkı tüketilmez;
  - bütün havuz denendikten sonra devir durur;
  - başarılı run dolu işaretini temizler.
- Faz 4: %95 eşiğini geçen aday atlanır ve `exhausted_until = resetsAt`
  yazılır; taze önbellekte tekrar sorgu yapılmaz; sorgu hatasında aday
  engellenmez; API key adayı sorgulanmaz.
- Yeni bir hesap yeni bir Claude oturumu başlatır (kimlik değişti); aynı
  hesapta oturum devam eder.
- Rotalar: board dışındaki aktörler ve başka şirketten gelen istekler
  reddedilir; değişiklikler activity log'a yazılır.
- UI: havuz kartının render testi.
- Teslim öncesi: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`,
  `pnpm check:token-gates`.

## Riskler

- **Kullanım koşulları.** Pro ve Max kişisel aboneliklerdir. Birden fazla
  aboneliği limitleri aşmak için sırayla kullanmak Anthropic koşullarına
  takılabilir. Karar sahibi işletmedir; koşullar ayrıca kontrol edilmeli.
  Koşullara daha uygun bir yedek olarak havuza bir Anthropic API key eklenebilir;
  havuz bunu destekliyor.
- **Oturum kaybı.** Devirde Claude konuşma geçmişi taşınmaz. Uzun görevlerde
  bağlam yeniden kurulurken ek token harcanır.
- **Yanlış sıfırlanma tahmini.** Sıfırlanma saati yoksa 60 dk varsayılır. Erken
  dönülürse bir run daha düşer ve süre tekrar uzar.
- **Genişletilmiş overlay.** Overlay artık sunucuyu da değiştiriyor. Lockfile
  eşitliği kontrolü bağımlılık sapmasını yakalar. İlk devreye alma, mevcut
  `deploy-image.sh` ile otomatik geri dönüş korunarak ve aktif run yokken
  yapılmalı.
- **Upstream ile uyum.** Yeni bağlama modu ve tablolar upstream'de yok. Sonraki
  resmi sürüme geçerken bu dal rebase edilecek; değişiklikler mümkün olduğunca
  ek dosyalarda tutulacak.

## Açık Sorular

1. Her şirkete hangi hesaplar atanacak ve sıraları ne olacak? Sunucu
   token'ının hangi hesaba ait olduğu da netleşmeli.
2. Cleanio'ya ikinci bir hesap atanacak mı?

Yanıtlananlar: 60 dk varsayılanı onaylandı; Faz 4 ilk teslime dahil.
