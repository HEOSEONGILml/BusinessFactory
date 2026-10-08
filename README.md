# BusinessFactory

AI 직원들이 사람 대신 일하는 범용 업무 시스템. 사용자는 목표를 주고 결재만 한다. 설계는 [docs/DESIGN.md](docs/DESIGN.md) 참고.

## 요구 사항

- Node.js 24 이상
- Claude Code, 구독 계정으로 로그인된 상태 (`claude` 를 한 번 실행해 확인)

## 시작하기

```sh
npm install
bin/bf init              # 회사 설립: company/ 생성, 기본 직원 4명과 핸드북 복사
bin/bf goal "목표"        # 목표 지시
npm start                # 엔진 실행 (Ctrl+C 로 정지 — 진행 중인 실행은 마무리)
```

Windows 명령 프롬프트/PowerShell 에서는 `bin\bf.cmd` 를 쓴다.

## 사용자가 하는 일

| 하고 싶은 것 | 명령 |
|---|---|
| 현황 보기 | `bf status` |
| 처리할 일 보기 (결재, 질문, 끝난 목표) | `bf inbox` |
| 결재 승인 / 반려 | `bf approve <번호>` / `bf deny <번호> "사유"` |
| 대기 중인 채용안 보기 | `bf hire list` |
| 질문에 답하기 | `bf task answer <번호> "답"` |
| 업무 내용과 이력 보기 | `bf task show <번호>` |
| 끝난 목표 확인 처리 | `bf ack <번호>` |
| 사용량 보기 | `bf usage` |
| 목표 취소 | `bf task cancel <번호>` |

엔진이 켜져 있으면 결재 요청, 직원 질문, 목표 완료, 엔진 정지 때 Windows 알림이 뜬다. 휴대폰 알림은 `company/config.yaml` 의 `notify.ntfy_topic` 에 ntfy 주제 이름을 넣으면 켜진다.

설정(동시 실행 수, 재시도 횟수 등)은 `company/config.yaml`, 정기 업무는 `company/schedules.yaml`.

## 주의

- 시스템 환경변수에 `ANTHROPIC_API_KEY` 가 있어도 엔진은 직원 실행 시 이를 지우고 구독 로그인을 쓴다.
- 직원 명부(`company/staff/`)나 시스템 코드가 실행 중에 승인 없이 바뀌면 엔진이 스스로 멈춘다. 직접 직원 파일을 고쳤다면 `company` 폴더에서 커밋한 뒤 엔진을 다시 켠다.

## 개발

```sh
npm test             # 테스트 (실제 Claude 를 호출하지 않음)
npm run typecheck    # 타입 검사
```
