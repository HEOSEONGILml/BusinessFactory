# 미션 (Mission) — 확정 설계

> 출처: 초안 `company/board/T0085/output/mission-design.md`(ceo), 비판 검토 `company/board/T0086/output/design-review.md`(reviewer). 이 문서는 검토를 반영해 확정한 설계이고, 구현(T0087)은 이 문서를 따른다. 검토 지적별 반영 여부는 12장에 있다.
>
> 원칙: "엔진은 판단하지 않는다"(DESIGN.md 2-2). 엔진은 루프를 돌리고, 기록하고, 안전장치를 강제한다. 무엇을 할지는 단계를 맡은 직원이 정한다.

## 1. 두 가지 지시 방식

| 방식 | 단위 | 다음 일을 누가 정하나 | 끝 |
|---|---|---|---|
| 업무 지시 (기존) | 목표 하나 (`bf goal`) | owner | 목표 완료 |
| 미션 (신규) | 분기 규모의 방향 (`bf mission create`) | 매 단계 ceo가 판단 | 달성 확정·기한·중지 |

- 미션 안의 한 바퀴를 **단계(step)**라 부른다. 단계 하나 = 최상위 목표 하나(담당 `config.ceo`, 지시자 owner, 메타 `mission: M001`).
- 여러 미션이 동시에 진행될 수 있다. 미션 하나에 진행 중인 단계는 1개다(단계 안의 하위 업무는 병렬).
- **미션 전담 직원은 없다.** 매 실행은 기억 없이 시작하므로 연속성은 미션 파일(헌장·진행 기록)로만 이어진다.

## 2. 저장 구조

```
company/missions/M001/
  mission.md     YAML 메타 + 본문(## 원문 = owner가 준 내용 그대로, ## 헌장 = 현재 헌장)
  journal.md     진행 기록. 덧붙이기만 한다 (등록, 단계 시작·종료, 헌장 보강, 일시정지·재개, 사용량 대기, 달성·중지)
```

메타 필드:

| 필드 | 의미 |
|---|---|
| id, title | `M001`, 제목 |
| status | `active` / `paused` / `achieved` / `stopped` |
| weight | 미션 예산 배분 비중 (기본 1) |
| until | 기한 (`YYYY-MM-DD` = 그날 끝, 로컬 시각) 또는 null |
| project, workspace | 단계 목표에 그대로 붙는다 |
| paused_reason | 일시정지·중지 사유 |
| hold | 엔진 기록: 지금 사용량 때문에 쉬는 중이면 `budget` / `ceiling` (변할 때만 보고하려고 둔다) |
| resumed_at | 재개 시각. 연속 실패·빈 단계는 이 뒤에 만든 단계만 센다 |
| alerts | 엔진 기록: 현재 단계에서 이미 보낸 경보 키 (중복 알림 방지) |
| created_at, updated_at, ended_at | 시각 |

- **단계 목록·현재 단계·연속 실패 수는 저장하지 않는다.** 보드에서 `mission == M001 && parent == null`인 업무로 계산한다(검토 권장 7). 단계 생성의 멱등성도 보드 기준이다("열린 단계가 없을 때만").
- `mission.md` 쓰기는 `company/.mission-lock` 잠금 안에서 한다(CLI와 엔진이 함께 쓴다).
- 업무 메타에 선택 필드 두 개를 더한다. 옛 업무 파일에는 없고, 없으면 미션과 무관한 업무로 읽힌다.
  - `mission`: 단계는 엔진이 넣고, 하위 업무는 **생성 시 부모에게서 상속해 저장**한다(`project`·`workspace`와 같은 방식, 검토 권장 4).
  - `mission_proposal`: 단계가 낸 달성/진전 없음 제안 `{kind, text, at}` (5장).

## 3. 루프

```
등록(active) ─▶ 엔진: 단계 목표 생성 ─▶ ceo: 평가 → 계획 → (큰 단계면 계획 검토) → 위임/직접 수행
     ▲                                                   │
     │                                         최상위 검수(reviewer, 헌장 대비)
     │                                                   │
     └── 엔진: journal 기록, 제안 적용, 안전장치 검사 ◀── 단계 종료(done/failed/canceled)
```

엔진 틱마다(`MissionLoop.tick`, `engine/src/missions.ts`) 미션별로:

1. **단계 정산**: 끝났는데 journal에 아직 없는 단계를 기록한다(완료 보고, 실행 수, 추정 사용량, 하위 업무 완료 수, 제안, `다음:` 줄). 그다음 5·6장의 판정을 적용한다.
2. **감시**: 열린 단계의 폭주 경보, 사용자 대기 경보(6장).
3. **사용량 대기**: 예산·구독 상한 상태가 바뀌면 journal과 보고에 남긴다.
4. **단계 생성**: `active`이고 열린 단계가 없고 기한 전이고 대기 중이 아니면 다음 단계를 만든다.
   - 제목: `[M001] 단계 N: <직전 단계 '다음:' 줄 첫 60자>` (첫 단계는 미션 제목). 단계가 무엇을 하는지 보드에서 보이게 한다(검토 권장 6).
   - 설명: `templates/mission-step.md`를 채운 것(헌장·journal 경로, 직전 단계와 그 '다음:' 판단, 4장 절차).
   - 완료 조건: `output/plan.md`(평가·계획), `output/report.md`(한 일·결과물·헌장 대비 진척, 요약 마지막 줄 `다음:`).
   - 우선순위는 0. 미션 업무의 순서는 7장의 정렬이 정한다(검토 권장 9).
5. 정기 보고(8장).

## 4. 단계 절차 (ceo 정의·핸드북·단계 템플릿에 반영)

1. 헌장, journal, 직전 단계 결과를 읽고 **평가**한다. 헌장이 빈약하면 `bf mission charter`로 보강한다(원문 보존, journal에 기록).
2. 달성이라고 판단하면 `bf mission achieve M001 --summary "<기준별 근거>"` 후 보고서를 쓰고 완료 보고.
3. 진전이 없다고 판단하면 `bf mission stall M001 --reason "..."` 후 완료 보고.
4. 아니면 `output/plan.md`를 쓴다. **큰 단계**(하위 업무 3개 이상, 외부 공개·결재 포함, 방향 전환)면 먼저 `bf task create --plan-review`로 계획 검토만 맡기고 실행을 끝낸다. 검토가 끝나 깨어나면 반영해 plan.md를 고치고(끝에 '## 검토 반영') 실무 하위 업무를 만든다.
5. 하위 업무가 끝나 깨어날 때마다 계획을 고친다(기존 동작).
6. 완료 보고 요약 마지막 줄은 `다음: <다음 단계에 넘길 판단>`.

**단계에는 맡긴 사람이 없다.** 단계 목표의 지시자는 owner라서 일반 질문이 owner에게 가고 단계 전체가 멈춘다. 그래서 `bf`가 미션 단계(최상위)의 일반 `bf task ask`를 거부하고 안내한다(가정하고 진행, 사용자 일은 사용자 업무로). `--owner` 질문은 "사용자 답 없이는 한 걸음도 못 갈 때"를 위해 남긴다. 하위 업무의 질문은 평소처럼 단계 담당자에게 간다(검토 필수 5).

**계획 검토의 강제**: 크기를 담당자가 스스로 선언하는 `bf mission plan --size`와 생성 거부 장치는 두지 않는다. 대신 단계 최상위 검수에서 "큰 단계인데 계획 검토가 없으면 반려"한다(검토 권장 5). `--plan-review` 업무는 담당 reviewer, **검수 없음**(reviewer가 자기 검토를 다시 검수하지 않게), 완료 조건 자동(`output/plan-review.md`에 필수/권장 지적과 판정). 미션이 아닌 목표에서도 쓸 수 있다.

## 5. 달성과 진전 없음은 검수 통과 후에만 확정

- `bf mission achieve/stall`을 단계 담당자가 쓰면 **제안**으로 단계 메타 `mission_proposal`에만 적는다.
- 엔진은 그 단계가 **검수를 통과해 done이 됐을 때만** 적용한다: achieve → `achieved` + 최종 보고, stall → `paused` + 보고.
- 검수 반려되면 `bf`가 제안을 지운다(이력에 '미션제안취소'). 재작업 실행이 다시 판단한다.
- 검수 지시에는 미션 헌장 경로와 제안 내용이 붙고, reviewer 정의에 "달성 제안은 헌장의 성공 판정 기준을 하나씩 대조해 모두 충족할 때만 통과"가 있다(검토 필수 3).
- owner가 단계 밖에서 `bf mission achieve`를 쓰면 바로 달성으로 끝난다(owner 판단). owner의 stall은 일시정지와 같다.

## 6. 멈출 조건 (안전장치)

| 조건 | 판정 | 동작 |
|---|---|---|
| 달성 | achieve 제안 단계가 검수 통과 | `achieved`, 최종 보고 |
| 기한 | `until` 경과 | 진행 중 단계는 끝까지, 이후 새 단계 없이 `stopped`. 최종 보고는 엔진이 파일에서 조립(마무리 단계 없음, 검토 권장 8) |
| 반복 실패 | 연속 `missions.failure_streak`(2)개 단계가 failed (검수 반려 한도 소진도 failed) | `paused` + 보고 |
| 진전 없음 (기계 판정) | 연속 `missions.empty_streak`(2)개 단계가 **빈 단계**: 완료된 하위 업무 0개, output/에 plan.md·report.md·plan-review.md 말고 파일 없음 | `paused` + 보고 (검토 권장 2) |
| 진전 없음 (선언) | stall 제안 단계가 검수 통과 | `paused` + 보고 |
| 단계 취소 | owner가 단계를 취소 | `paused` (방향 확인 필요). `bf mission stop --cancel-running`으로 인한 취소는 `stopped` 그대로 (검토 권장 3) |
| 미션 예산 | 7일 이동 창 미션 추정 사용량 ≥ 미션 몫 | **그 미션의 업무를 새로 시작하지 않는다**(진행 중 단계의 하위 업무 포함). 진행 중 실행과 검수는 마친다. 창이 풀리면 자동 재개. 대기·재개를 보고 (검토 필수 1) |
| 구독 상한 | 구독 `seven_day` 사용률 ≥ `missions.seven_day_ceiling`(0.7) | 미션 업무를 새로 시작하지 않는다. 사용률 기록이 `probe_after_hours`(6시간)보다 오래되면 미션 업무 **1건**을 보내 새 값을 받아 온다(열린 단계가 없으면 단계 1개를 만든다). 기존 `usage_ceiling`은 그대로 전체 정지선 (검토 필수 4) |
| 폭주 경보 | 한 단계의 하위 업무 > `step_task_alert`(40) 또는 깊이 > `step_depth_alert`(10) | 보고만, 멈추지 않음 (단계마다 1회) |
| 사용자 대기 경보 | 단계나 그 하위 업무가 결재·질문·사용자 업무로 `blocked_alert_hours`(24시간) 이상 사용자를 기다림 | 보고만 (건마다 1회, 검토 권장 1) |
| owner 제어 | `bf mission pause/stop` | pause: 새 단계를 만들지 않고 그 미션의 업무도 새로 시작하지 않음. stop: 새 단계 없음, 진행 중 단계는 `--cancel-running`이면 취소, 아니면 끝까지 |

- 미션 몫 = `missions.weekly_budget_usd × weight / Σ(active 미션 weight)`. `weekly_budget_usd: null`이면 예산 없음.
- 사용량 귀속: `usage.jsonl`의 `task`가 미션 업무(메타 `mission`)인 항목의 `cost_usd_estimate` 합. work·review·comment 실행이 들어가고, **chat 실행은 대화 id로 기록되므로 미션 예산에서 빠진다**(최근 7일 비용의 약 21%, 검토 권장 4). `usage.jsonl`은 크기·수정 시각이 바뀔 때만 다시 읽는다.
- `cost_usd_estimate`는 구독 실제 차감과 다르다. 그래서 구독 사용률 상한을 이중으로 둔다.
- `paused` 미션은 `bf mission resume`(또는 웹 재개 버튼)으로 owner가 재개한다. 예산·구독 대기는 자동 재개다.

## 7. 우선순위와 사용량 배분

- 실행 후보 순서: **검수 > owner 목표(미션 없음, 기존 우선순위 정렬) > 미션 업무**.
- 미션 업무끼리는 `7일 사용량 / weight` 오름차순(덜 쓴 미션 먼저), 같으면 기존 순서.
- 미션별 priority는 두지 않는다. 손잡이는 weight와 pause뿐이다(검토 권장 9). 단계 목표의 업무 우선순위는 0이고, 미션 업무는 업무 priority가 높아도 owner 목표를 앞지르지 않는다.
- 동시 실행 중 미션 업무 자리 상한 `missions.max_slots`(null = `max(1, max_concurrency - 1)`). owner 목표용 자리를 남긴다.

## 8. 보고

엔진의 보고는 **Claude 실행 없이** 파일에서 조립한다.

- 보고는 owner와 ceo의 DM(`d-ceo--owner`)에 ceo 이름의 **`kind: system`, `chain: max_chain`** 메시지로 올린다. 그래서 ceo 답장 실행이 생기지 않는다(검토 권장 10). 그리고 알림(ntfy 등)을 보낸다.
- **정기 보고**: `missions.report_cron`(기본 매일 09:00) 하나로 진행·일시정지 미션(과 지난 보고 이후 끝난 미션)을 한 메시지에 담는다(미션별 cron은 두지 않음, 검토 권장 8). 미션마다 상태, 현재 단계와 plan.md 첫 줄, 지난 보고 이후 끝난 단계, 7일 사용량/몫, 사용자를 기다리는 것과 대기 시간. 실행 상태는 `company/.engine-mission-report.json`.
- **사건 보고**(즉시): 단계 종료(DM만, 알림 없음), 달성, 일시정지(사유), 기한·중지(최종 보고), 사용량 대기·재개, 폭주 경보, 사용자 대기 경보. 모두 journal에도 남는다.
- 결재와 사용자 업무는 기존 흐름 그대로 처리할 일·알림으로 간다.
- **끝난 단계는 처리할 일에 쌓이지 않는다.** done인 미션 단계는 `Board.finishedForOwner`가 제외하고, 처리할 일(웹), 알림(`ownerItems`), `bf inbox`가 모두 이 판정을 쓴다. failed 단계는 그대로 처리할 일에 남는다(검토 권장 11).

## 9. 명령어

| 명령 | 누가 | 설명 |
|---|---|---|
| `bf mission create "<제목>" [--brief "<헌장>"] [--file 헌장.md] [--weight W] [--until 날짜] [--project P] [--workspace W]` | owner | 등록. 다음 엔진 틱에 첫 단계 생성 |
| `bf mission list` / `bf mission show M001 [--journal n]` | 모두 | 상태, 단계, 사용량/몫, 헌장, 진행 기록 |
| `bf mission pause M001 [--reason ...]` / `resume M001` | owner | 일시정지·재개 |
| `bf mission stop M001 [--cancel-running] [--reason ...]` | owner | 중지 |
| `bf mission set M001 [--weight W] [--until 날짜\|""] [--title ...]` | owner | 조정 (journal에 기록) |
| `bf mission charter M001 --file f \| --text "..."` | owner, 그 미션 단계 담당자 | 헌장 보강 (원문 보존) |
| `bf mission achieve M001 --summary "..."` / `bf mission stall M001 --reason "..."` | 단계 담당자 (owner는 즉시 확정) | 달성 제안 / 진전 없음 선언 |
| `bf task create --plan-review [--desc "<볼 점>"] [--title ...]` | 업무 수행 중인 누구나 | 지금 업무의 `output/plan.md` 비판 검토를 reviewer에게 (검수 없음) |

웹: 상단 '미션' 탭 — 등록 폼, 미션별 상태·대기 사유·7일 사용량/몫·단계 목록(누르면 업무 상세)·헌장·진행 기록, 일시정지·재개·중지 버튼. API: `GET /api/missions`, `POST /api/mission`, `POST /api/mission/<id>/pause|resume|stop`.

## 10. 설정 (config.yaml)

```yaml
max_depth: null            # 위임 깊이 고정 제한 없음 (키가 없어도 null). 숫자를 넣으면 예전처럼 막는다
missions:
  weekly_budget_usd: 300   # null = 예산 없음
  seven_day_ceiling: 0.7
  probe_after_hours: 6
  max_slots: null          # null = max_concurrency - 1 (최소 1)
  failure_streak: 2
  empty_streak: 2
  step_task_alert: 40
  step_depth_alert: 10
  blocked_alert_hours: 24
  report_cron: "0 9 * * *"
```

- `missions` 블록이 없는 옛 설정은 위 기본값으로 읽는다. 일부 키만 있어도 나머지는 기본값.
- `max_depth`: 기본값이 3에서 null로 바뀌었다. 비교는 `typeof max_depth === 'number'`일 때만 한다(`1 > null`이 true가 되는 JS 함정, 검토 필수 2).
- `max_attempts`, `max_rejections`는 업무별 무한 반복 방지 장치라 그대로다.

### 사용량 수치 참고

[사실] 검토 시점 최근 7일 합계 $41.87, 그때 구독 seven_day 0.04. [추정] 100% ≈ $1,000/주이므로 `weekly_budget_usd: 300` ≈ 30%, 0.7 상한 ≈ $700으로 서로 어긋나지 않는다(T0086 검토 권장 4).

## 11. 테스트 (`engine/test/missions.test.ts`, 가짜 Claude)

- 단계 자동 생성 → 종료 → journal 기록 → 다음 단계(제목에 '다음:' 반영) → achieve 제안 단계 검수 통과 시 달성, 이후 단계 없음. 끝난 단계는 처리할 일·'목표 완료' 알림에 없음, 보고는 system 메시지
- achieve 제안 후 검수 반려 → 제안 취소, 미션 계속
- 실패 연속 2회 → paused + 알림, 실패 단계는 처리할 일에 남음
- 빈 단계 연속 2회 → paused
- 예산 초과 → 진행 중 단계의 다음 실행도 시작 안 함, owner 목표는 계속 실행, 7일 경과 후 자동 재개
- 구독 상한 → 단계 생성 보류, 기록이 6시간 넘게 오래되면 1건 탐침
- owner 목표 우선, 미션 슬롯 상한(업무 priority가 높아도)
- 폭주 경보 1회, 멈추지 않음
- owner 단계 취소 → paused, `stop --cancel-running` → stopped
- 기한 경과 → stopped + 최종 보고
- 정기 보고: 시각에 1회, Claude 실행 없음
- 단계 일반 질문 거부·`--owner` 허용·하위 업무 질문은 평소대로
- `--plan-review`: plan.md 필요, reviewer 담당·검수 없음·미션 상속
- 검수 지시에 헌장·달성 제안 포함
- 헌장 수정 권한과 원문 보존
- `bf mission` 명령 전반, 사용자 전용 제어
- `max_depth`: 설정에 명시적 null → 깊이 6 위임 성공, 키 없음 → null, 숫자 → 예전처럼 거부
- 옛 형식: `mission` 필드 없는 업무, `missions` 블록 없는 설정
- 웹: 미션 등록·목록·제어 API (`engine/test/web.test.ts`)

## 12. 검토(T0086) 지적별 반영

| 지적 | 반영 | 어디에 |
|---|---|---|
| 필수 1. 예산이 진행 중 단계의 폭주를 못 막음 | **반영**: 예산 초과 미션의 업무를 실행 후보에서 뺀다(검수·진행 중 실행은 계속) | 6장, `Engine.orderWork`, `MissionLoop.gate` |
| 필수 2. `max_depth: null`이면 위임이 전부 거부됨 | **반영**: 타입 `number \| null`, 기본 null, 숫자일 때만 비교. 회사 설정에서 `max_depth: 3` 삭제. DESIGN.md 갱신. 명시적 null 테스트 | 10장, `board.ts`, `config.ts` |
| 필수 3. achieve가 검수 전에 확정됨 | **반영**: 제안으로만 기록, 단계가 검수 통과해 done일 때 확정. 반려 시 제안 취소. stall도 같은 방식 | 5장 |
| 필수 4. 미션 상한에 걸리면 사용률이 갱신되지 않아 멈춤 | **반영**: 기록이 6시간보다 오래되면 미션 업무 1건 탐침(열린 단계가 없으면 단계 생성). 대기·재개를 보고 | 6장 |
| 필수 5. 단계 질문이 전부 owner에게 감 | **반영**: 단계 템플릿·ceo 정의·핸드북에 지침 + `bf`가 미션 단계의 일반 질문을 거부(`--owner`는 허용) | 4장 |
| 권장 1. 막힌 단계로 무기한 정지 | **반영**: 정기 보고에 대기 시간, 24시간 이상이면 사건 보고. 단계 지침에 "결재·사용자 일은 하위 업무로 분리" | 6·8장, 템플릿 |
| 권장 2. 진전 없음 기계 판정 | **반영**: 빈 단계 연속 2회 → paused. 선언은 보조 | 6장 |
| 권장 3. 단계 취소의 의미 | **반영**: owner 취소 → paused, stop --cancel-running → stopped | 6장 |
| 권장 4. 사용량 귀속·타입·캐시 | **반영**: chat 제외 명시, 합산은 `UsageEntry.kind` 타입에 기대지 않고 원시 JSON을 읽음, mtime 캐시, `mission`은 생성 시 상속 저장 | 2·6장 |
| 권장 5. `mission plan --size`·생성 거부 단순화 | **반영**: 해당 명령·메타·거부 로직 없음. `--plan-review`만(검수 없음, 완료 조건 자동), 최상위 검수에서 사후 감시 | 4장 |
| 권장 6. 단계 제목을 실제 내용으로 | **반영**: 직전 단계 '다음:' 줄을 다음 단계 제목에 사용(별도 step-title 명령은 두지 않음) | 3장 |
| 권장 7. steps/current_step/failure_streak는 보드에서 계산, mission.md 잠금 | **반영** | 2장 |
| 권장 8. 마무리 단계·미션별 report_cron 제거 | **반영**: 기한 시 엔진이 최종 보고 조립, 정기 보고는 전역 cron 하나 | 6·8장 |
| 권장 9. priority와 weight 중 하나로 | **반영**: 미션 priority 없음(초안의 `--priority` 옵션 제거), weight와 pause만. 단계 업무 우선순위 0, 정렬 키 변경 | 7장 |
| 권장 10. 보고는 system 메시지로 | **반영** | 8장 |
| 권장 11. 처리할 일 제외는 두 곳 함께 | **반영**: `Board.finishedForOwner` 하나로 board·web·notify·`bf inbox` 모두 판정 | 8장 |

## 13. 위험과 남은 일

- **사용량 추정 오차**: `cost_usd_estimate`는 구독 실제 차감과 다르다. 구독 사용률 상한을 이중으로 둔다.
- **방향 표류**: 매 단계 헌장 재독, 최상위 검수가 헌장 대비 판정.
- **자기 수정**: 미션이 BusinessFactory 시스템 코드를 고치는 일은 헌장에 명시될 때만 한다(단계 템플릿).
- **엔진 재시작 필요**: 미션 루프·후보 정렬은 엔진 프로세스 안에 있다. `bf mission` 명령은 재시작 없이 바로 쓸 수 있지만, 단계 생성은 새 코드로 엔진을 다시 띄운 뒤부터 동작한다.
- 탐침 중 사용률이 계속 높으면 6시간마다 미션 실행 1건이 나간다(의도된 비용).
