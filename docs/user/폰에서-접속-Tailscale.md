# 폰에서 접속하기 (Tailscale)

노트북에서 돌고 있는 OhMyDate를 같은 tailnet에 있는 폰에서 여는 방법입니다. 앱은 계속 노트북 안쪽(`127.0.0.1`)에만 열려 있고, Tailscale이 내 기기끼리만 통하는 주소를 그쪽으로 이어 줍니다. 인터넷에는 공개되지 않습니다.

## 한 번만 하는 준비

1. **Tailscale 관리 콘솔에서 HTTPS 인증서 켜기** — <https://login.tailscale.com/admin/dns> 아래쪽 "HTTPS Certificates" → Enable. 로그인 쿠키는 HTTPS에서만 저장되기 때문에 필요합니다(`http://100.x.x.x` 주소로는 로그인이 되지 않습니다).
2. **이 기계의 tailnet 이름 확인** — `tailscale status --json | grep DNSName | head -1` (예: `laptop.tail1234.ts.net`).
3. **앱에 그 이름을 허용** — 저장소의 `.local/local.override.env` 파일(커밋되지 않는, 이 기계만의 설정)에 한 줄:

   ```
   WEB_ALLOWED_HOSTS=laptop.tail1234.ts.net
   ```

   정확한 이름만 됩니다(`*.ts.net` 같은 와일드카드는 거부되고 웹이 뜨지 않습니다). 그 뒤 `corepack pnpm run local:stop` → `corepack pnpm run local:start`.
4. **Tailscale로 잇기** — `tailscale serve --bg 5180` (웹 포트가 다르면 그 번호). 끄려면 `tailscale serve --https=443 off`, 상태는 `tailscale serve status`.

## 쓰기

폰(같은 tailnet에 로그인된 Tailscale 앱이 켜진 상태)의 브라우저에서 `https://laptop.tail1234.ts.net` 을 열고 로그인합니다. 홈 화면에 추가해 두면 앱처럼 열립니다.

## 알아 둘 것

- 노트북이 켜져 있고 절전 상태가 아닐 때만 열립니다.
- 폰과 노트북은 로그인이 따로입니다(주소가 달라 쿠키가 다릅니다).
- 구글 캘린더 **연결**(재연결)은 노트북에서 `http://127.0.0.1:5180`으로 해야 합니다. 구글에 등록한 주소가 그것이기 때문입니다. 이미 연결된 뒤에는 폰에서도 그대로 보입니다.
- `tailscale serve`는 내 tailnet의 기기에만 열립니다. `tailscale funnel`(인터넷 공개)은 쓰지 마세요: 이 앱은 그런 노출을 전제로 만들어지지 않았습니다.
