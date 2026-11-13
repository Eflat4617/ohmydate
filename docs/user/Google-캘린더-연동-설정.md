# Google 캘린더 연동 설정 (안드로이드 폰과 일정 맞추기)

> 대상: 이 노트북의 주인. 개발 지식 없이 따라 할 수 있게 썼어요. 처음 한 번 15–20분쯤 걸려요.
> 기준: CAL-03(서버 쪽 연동) 코드. 영어로 적은 `Create`, `Web application` 같은 이름은 Google Cloud 콘솔의 버튼·메뉴 이름이에요. 콘솔을 한국어로 보고 있으면 같은 자리의 한국어 이름을 누르면 돼요(예: Create → 만들기).
> 비밀값(클라이언트 비밀, 토큰)은 이 문서 어디에도 없고, 화면이나 피드백에 붙여 넣지 말아 주세요.

## 무엇이 되나요

- **폰 → OhMyDate:** 폰의 Google 캘린더에 있는 일정 중 **시간이 정해진 일정**(예: 14:00–15:00 치과)은 OhMyDate의 ‘약속’에 그대로 들어와서, 그 시간에는 작업을 배치하지 않아요. **종일 일정**(휴일, 여행)은 따로 보여 주기만 하고 시간을 막지 않아요. 취소된 일정, 내가 ‘아니요’로 답한 초대, ‘한가함’으로 표시한 일정은 가져오지 않아요.
- **OhMyDate → 폰:** OhMyDate가 Google 계정에 **"OhMyDate"라는 캘린더를 하나 만들어** 거기에만 써요. 승인한 작업 블록, 직접 만든 약속, 그리고 하루에 한 번 **"오늘 할 일 N개"** 요약(그날 할 일 시간·제목 목록)이 들어가고, 시작 10분 전에 폰에 알림이 떠요(설정에서 바꿀 수 있어요).
- 앱은 **내 원래 캘린더를 읽기만** 해요. 내 일정을 바꾸거나 지울 권한 자체를 받지 않아요.
- 5분마다 자동으로 맞추고, OhMyDate에서 일정안을 승인하거나 약속을 고치면 몇 초 안에 폰으로 보내요.

### 밖으로 나가는 것

Google로 보내는 것은 **작업 제목, 블록 시각, 직접 만든 약속의 제목·시각·반복 규칙, 그것으로 만든 하루 요약**뿐이에요. 노트, 작업 설명, 목표 문장, Google에서 가져온 약속은 보내지 않아요. 노트북은 `accounts.google.com`(동의 화면, 브라우저가 열어요), `oauth2.googleapis.com`, `www.googleapis.com`에만 연결해요.

### 시작 전에 알아 둘 것

- **앱은 꼭 `http://127.0.0.1:5180/` 주소로 열어 주세요.** `localhost:5180`으로 열면 연결이 끝나고 돌아올 때 로그인이 이어지지 않아 실패해요.
- Google 계정(Gmail)과, 그 계정으로 쓰는 폰의 Google 캘린더 앱이 있으면 돼요. Google Cloud 사용은 이 용도로는 **무료**예요(결제 수단을 등록하라고 하지 않아요).

---

## 1. Google Cloud 프로젝트 만들기

1. 브라우저에서 <https://console.cloud.google.com/> 에 들어가 폰과 같은 Google 계정으로 로그인해요. 처음이면 서비스 약관 동의 창이 떠요.
2. 왼쪽 위 **메뉴(≡) → `IAM & Admin` → `Create a Project`** 를 눌러요. (화면 위쪽 프로젝트 선택 상자 → `New project` 로 가도 같아요.)
3. `Project name`에 `OhMyDate`를 적고 `Create`를 눌러요. 몇 분 안에 만들어져요.
4. 화면 위쪽 프로젝트 선택 상자에 **OhMyDate**가 선택돼 있는지 확인해요. 아래 단계는 모두 이 프로젝트 안에서 해요.

## 2. Google Calendar API 켜기

1. **메뉴(≡) → `APIs & Services` → `Library`** 로 가요.
2. 검색창에 `Google Calendar API`를 적고 결과를 눌러요.
3. **`Enable`** 을 눌러요. (바로 가기: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>)

## 3. 동의 화면(Google Auth Platform) 설정

1. **메뉴(≡) → `Google Auth platform` → `Branding`** 으로 가요. “Google Auth platform not configured yet”이라고 나오면 **`Get Started`** 를 눌러요.
2. 순서대로 채워요.
   - `App Information`: `App name`에 `OhMyDate`, `User support email`에 내 Gmail → `Next`
   - `Audience`: **`External`** 선택 → `Next` (Internal은 회사·학교 조직 계정에서만 보여요)
   - `Contact Information`: 내 Gmail → `Next`
   - `Finish`: “Google API Services: User Data Policy”에 동의 체크 → `Continue` → **`Create`**
3. **테스트 사용자 추가:** 왼쪽 **`Audience`** → `Test users` 아래 **`Add users`** → 내 Gmail 주소 → `Save`.
4. **권한(scope) 등록:** 왼쪽 **`Data Access`** → **`Add or Remove Scopes`** 를 눌러요. 열린 창 아래쪽의 ‘직접 추가’ 칸에 아래 세 줄을 붙여 넣어 목록에 추가하고, 세 항목이 체크된 채로 창을 닫은 뒤 페이지의 **`Save`** 를 눌러요. (창 안의 버튼 이름은 콘솔 버전에 따라 조금 달라요.)

   ```text
   https://www.googleapis.com/auth/calendar.app.created
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events.readonly
   ```

   - `calendar.app.created`: 앱이 만든 "OhMyDate" 캘린더 하나만 만들고 고칠 수 있는 권한
   - `calendar.calendarlist.readonly`: 내 캘린더 목록 읽기
   - `calendar.events.readonly`: 내 일정 읽기

### 테스트 상태와 7일 만료 (중요)

지금 앱은 **`Testing`(테스트)** 상태예요. Google은 테스트 상태 앱의 승인을 **동의한 때부터 7일 뒤에 만료**시켜요. 그러면 OhMyDate 설정 화면에 ‘다시 연결 필요’로 나오고 동기화가 멈춰요(데이터는 지워지지 않아요). 그때마다 다시 연결하면 돼요.

7일마다 다시 연결하기 싫으면 **`Audience` 화면의 `Publish app`(앱 게시)** 을 눌러 상태를 `In production`으로 바꾸세요.

- 좋은 점: 7일 만료가 없어져요.
- 대가: Google의 확인(심사)을 받지 않은 앱이라, 연결할 때 **“Google에서 확인하지 않은 앱”이라는 경고 화면이 한 번** 나와요. 내가 만든 앱이니 화면의 고급(Advanced) 링크를 눌러 OhMyDate로 계속 진행하면 돼요. 이 앱은 나 혼자 쓰므로 Google이 정한 미확인 앱 사용자 수 제한(100명)과는 상관없어요.
- 게시하지 않고 테스트 상태로 써도 기능은 똑같아요.

## 4. OAuth 클라이언트 만들기 (웹 애플리케이션)

1. 왼쪽 **`Clients`** → **`Create Client`** 를 눌러요.
2. `Application type`: **`Web application`** (웹 애플리케이션).
3. `Name`: `OhMyDate 로컬` (콘솔에서만 보이는 이름이에요).
4. **`Authorized redirect URIs`** 아래 **`Add URI`** 를 누르고 아래 주소를 **한 글자도 다르지 않게** 붙여 넣어요. (`Authorized JavaScript origins`는 비워 둬요.)

   ```text
   http://127.0.0.1:5180/api/v1/integrations/google/callback
   ```

   - `localhost`가 아니라 `127.0.0.1`, 끝에 `/` 없음, `http`(s 없음)예요. 웹 포트를 바꿨다면(`deploy/local/local.env`의 `WEB_PORT`) 5180 대신 그 번호를 넣어요.
5. **`Create`** 를 눌러요.
6. **곧바로 JSON 파일을 내려받으세요.** 만든 직후 나오는 창의 다운로드 버튼(JSON 다운로드)을 눌러요. Google은 2025년 6월 이후 만든 클라이언트의 비밀을 **만들 때 한 번만** 보여 줘요. 창을 닫아 버렸다면 그 클라이언트 상세 화면에서 `Add Secret`으로 새 비밀을 만들고 그 JSON을 내려받으면 돼요.
   - 파일 이름은 보통 `client_secret_…json`이고 `다운로드` 폴더에 저장돼요.
   - 설정이 실제로 반영되기까지 몇 분(길면 몇 시간) 걸릴 수 있어요. 5단계까지 마친 뒤 바로 연결이 안 되면 조금 뒤에 다시 해 보세요.

## 5. 파일을 정해진 자리에 두고 다시 시작

터미널에서 저장소 폴더(예: `~/ohmydate`)로 가서 아래를 그대로 실행해요. (첫 줄의 파일 이름은 실제로 내려받은 이름에 맞게 바꿔요. 다운로드 폴더에 `client_secret_`으로 시작하는 파일이 하나뿐이면 그대로 써도 돼요.)

```sh
# 1) 내려받은 클라이언트 JSON을 정해진 자리로 옮기고, 나만 읽을 수 있게 해요
mv ~/Downloads/client_secret_*.json deploy/secrets/local/google-oauth-client.json
chmod 600 deploy/secrets/local/google-oauth-client.json

# 2) 토큰 암호화 키 만들기 (이미 있는 파일은 건드리지 않아요, 값은 출력하지 않아요)
corepack pnpm local:secrets

# 3) 앱 다시 시작
corepack pnpm local:stop
corepack pnpm local:start
```

`local:start` 출력에 이 줄이 보이면 성공이에요.

```text
[local] Google 캘린더 동기화: 설정됨 (리디렉션 URI: http://127.0.0.1:5180/api/v1/integrations/google/callback)
```

`corepack pnpm local:status`도 같은 `Google 캘린더 동기화:` 줄을 보여 줘요.

- `설정 안 됨 (OAuth 클라이언트 파일 없음: …)` → 1)의 파일 이름·위치를 확인해요.
- `… 권한이 644 입니다 … 정확한 명령: chmod 600 …` → 안내된 `chmod 600` 명령을 그대로 실행하고 다시 `local:start`.
- `… 형식이 올바르지 않습니다` → 다른 파일(예: 서비스 계정 키)을 넣었을 수 있어요. 4단계의 **웹 애플리케이션** 클라이언트 JSON을 다시 내려받아 넣어요.
- `Google 토큰 키 파일이 없습니다 …` → `corepack pnpm local:secrets`를 실행해요.

이 두 파일(`google-oauth-client.json`, `google-token.key`)은 비밀 파일이에요. git에 올라가지 않는 `deploy/secrets/local/`에 있고, 백업할 때 이 폴더를 통째로 함께 백업하세요. `google-token.key`를 잃으면 저장된 연결을 풀 수 없어 **다시 연결**해야 해요.

## 6. 앱에서 연결하기

1. 브라우저에서 **`http://127.0.0.1:5180/`** 을 열고 로그인해요.
2. **설정의 캘린더 화면**에서 Google 연결 버튼을 눌러요. (이 화면은 별도 작업(CAL-04)으로 추가돼요. 화면이 생기기 전에는 연결할 수 없어요.)
3. Google 로그인 → 테스트 상태라면 “Google hasn't verified this app”(확인되지 않은 앱) 안내가 나올 수 있어요. 내가 만든 앱이니 계속 진행해요.
4. 권한 화면에서 **세 항목 모두 체크**하고 `Continue`(계속).
   - 일정 읽기 항목을 빼면 **가져오기**가, "OhMyDate" 캘린더 항목을 빼면 **내보내기**가 꺼진 채로 연결돼요(설정 화면에 표시돼요). 다시 연결해서 체크하면 켜져요.
5. 자동으로 OhMyDate 설정 화면으로 돌아오고 ‘연결됨’으로 보여요. 몇 초 안에 첫 동기화가 시작돼요.

## 7. 폰에서 확인하기

1. 폰의 **Google 캘린더 앱**을 열고 왼쪽 메뉴(≡)를 열어요.
2. 내 계정 아래 **"OhMyDate"** 캘린더가 보이고 체크돼 있는지 확인해요. 안 보이면 잠시 뒤 아래로 당겨 새로 고침 하세요(폰이 Google과 동기화되는 데 시간이 걸릴 수 있어요).
3. 알림이 안 오면 폰 설정에서 Google 캘린더 앱의 알림이 켜져 있는지 확인해요. OhMyDate가 보내는 일정은 캘린더 기본 알림 대신 **OhMyDate 설정의 알림 시간**(기본 10분 전, ‘오늘 할 일’ 요약은 시작 시각)으로 울려요.

‘오늘 할 일’ 요약은 **그날 블록이 있는 날**에만, **내 하루 시작 시각**(가용 시간 설정의 하루 시작, 기본 08:00 — 첫 블록이 더 이르면 그 시각)에 10분짜리 일정으로 들어가요. 바쁜 시간으로 표시되지 않아요.

## 8. 자주 만나는 문제

| 증상 | 원인과 해결 |
|---|---|
| Google 화면에 `redirect_uri_mismatch` | 4단계의 리디렉션 URI가 정확히 같지 않아요. `127.0.0.1`(localhost 아님), 포트, 끝의 `/` 유무를 확인하고 저장한 뒤 몇 분 기다려요. |
| Google 화면에 `access_denied` 또는 ‘액세스 차단됨’ | 3단계 3)의 테스트 사용자에 이 Gmail을 넣었는지 확인해요(테스트 상태일 때). |
| 연결 후 설정 화면에 `google=error` | 로그인 세션이 이어지지 않았거나(앱을 `localhost`로 열었음), 10분 넘게 동의 화면에 머물렀어요. `http://127.0.0.1:5180/`으로 열고 다시 연결해요. |
| 7일 뒤 ‘다시 연결 필요’ | 테스트 상태의 정상 동작이에요. 다시 연결하거나 3단계의 `Publish app`을 하세요. |
| 폰 일정이 OhMyDate 약속에 안 들어옴 | 설정의 캘린더 목록에서 그 캘린더가 선택돼 있는지 확인해요(처음에는 내가 소유한 캘린더와 공휴일 캘린더만 선택돼요). 종일 일정·‘한가함’ 일정은 약속이 되지 않아요. |
| 가져온 약속을 OhMyDate에서 고칠 수 없음 | 의도된 동작이에요. Google 캘린더(폰)에서 고치면 다음 동기화(최대 5분)에 반영돼요. |

## 9. 연결 끊기

설정의 캘린더 화면에서 연결을 끊으면:

- Google에 준 권한을 폐기하고, 노트북에 저장된 연결 정보를 지워요.
- Google에서 가져온 약속·종일 일정은 OhMyDate에서 사라져요(내 Google 캘린더 원본은 그대로예요).
- 기본으로 Google의 **"OhMyDate" 캘린더도 지워요**. ‘폰에 남겨 두기’를 고르면 그 캘린더는 마지막 상태 그대로 남아요(다시 연결하면 새 "OhMyDate" 캘린더를 만들어요 — 남은 옛 캘린더는 가져오기 대상으로 자동 선택되지 않아요).
- 알림 시간 같은 설정은 남아서 다시 연결하면 그대로 써요.

Google 쪽에서 직접 끊으려면 Google 계정의 ‘타사 앱 및 서비스’ 연결 목록에서 OhMyDate를 삭제해도 돼요. 그러면 OhMyDate는 다음 동기화 때 ‘다시 연결 필요’로 바뀌어요.
