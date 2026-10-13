# tlk control

tlk.io 채널 메시지와 Instagram DM의 전송 간격·횟수를 설정하고, 진행 상태와 기록을 확인하는 도구입니다. Node.js 22 이상을 사용합니다.

## 로컬 실행

```powershell
$env:ALLOWED_ORIGINS='http://127.0.0.1:4173'
npm start
```

다른 터미널에서 `npm run preview`를 실행하고 `http://127.0.0.1:4173`을 여세요. 화면의 서버 연결 설정에 `http://127.0.0.1:3000`을 입력합니다. 테스트는 `npm test`로 실행합니다.

봇 수의 5개 제한은 없습니다. 봇 수와 총 전송 수는 정확한 집계를 위해 JavaScript가 안전하게 표현하는 정수 범위(1~9007199254740991)에서 입력합니다. 실제 생성 가능한 봇 수는 서버 자원과 서비스 제한에 따라 달라집니다. 전송 간격은 0~3600초이며 `0.0000001` 같은 작은 소수도 일반 십진수로 표시합니다. 지수 표기를 붙여 넣어도 입력란을 벗어나면 십진수로 바뀝니다. 총 전송 수에 소수는 사용할 수 없습니다. 실제 전송 속도는 타이머 정밀도와 네트워크 응답 시간에 따라 달라집니다.

## Instagram DM

서비스 선택에서 **Instagram DM**을 고른 뒤 보내는 계정 ID, 받는 사람 IGSID, Instagram 액세스 토큰과 메시지를 입력합니다. 한 계정으로 즉시 첫 메시지를 보낸 후 설정한 간격마다 전송하며, 총 횟수에 도달하면 종료합니다. tlk.io와 Instagram은 하나의 실행기를 공유하므로 동시에 한 작업만 실행할 수 있습니다.

준비 사항:

1. Meta 개발자 앱에 **Instagram API with Instagram Login**을 설정하고 비즈니스 또는 크리에이터 계정을 연결합니다.
2. `instagram_business_basic`, `instagram_business_manage_messages` 권한이 있는 Instagram 사용자 액세스 토큰을 발급합니다. Facebook Page 토큰이나 Instagram 비밀번호를 입력하는 방식이 아닙니다.
3. 보내는 프로페셔널 계정의 숫자 ID를 확인합니다. 받는 사람의 **Instagram-scoped ID (IGSID)**는 수신 메시지 웹훅의 `sender.id` 또는 Conversations API에서 얻습니다. @사용자 이름이나 프로필 링크는 사용할 수 없습니다.
4. 먼저 DM을 보낸 상대에게 마지막 수신 메시지로부터 표준 24시간 응답 가능 시간 내에 전송합니다. 개발 모드의 테스트 역할 및 일반 사용자용 앱 검토·권한 승인은 Meta 설정에서 준비합니다.

현재 구현은 텍스트 전송 기능입니다. OAuth 로그인, 토큰 갱신, 웹훅 수신, 수신함 조회는 포함하지 않습니다. 메시지 권한과 응답 가능 시간은 Meta가 검증하며, 거절·전송 제한·불명확한 응답 시 자동 재시도 없이 작업을 중지합니다. API는 `POST https://graph.instagram.com/v25.0/{account-id}/messages`를 사용합니다.

토큰은 시작 요청으로 선택한 실행기 서버에 전달되고 실행 중 메모리에서만 사용됩니다. 상태 응답·로그·브라우저 저장소에 넣지 않으며, 시작 성공 후 입력란을 비웁니다. 본인이 관리하거나 신뢰하는 HTTPS 실행기를 사용하세요. 기존 실행기 API는 인증 없이 공유되는 구조이므로 서버 URL을 아는 사람은 상태 조회와 중지가 가능합니다.

- [Meta Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Meta 공식 Instagram API 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)

실제 Instagram 전송은 유효한 계정·토큰·수신자가 필요합니다. 자동 테스트는 외부로 메시지를 보내지 않고 API 요청 형식, 오류 처리, 중지, 토큰 비노출을 검증합니다.
