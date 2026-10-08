# 서버 설치 안내 (Ubuntu)

Lightsail 등 Ubuntu 서버에서 BusinessFactory를 상시 운영하기 위한 순서. 사용자 계정은 `ubuntu`라고 가정한다. 서버의 Claude Code 세션은 이 문서를 위에서부터 따라 진행한다.

> 권장 사양: 메모리 4GB 이상. 직원 실행 하나는 최대 약 240MB를 쓴다 (2026-10-08 측정). 동시 실행 4개와 빌드를 합쳐도 2~2.5GB 정도다.
> 운영 중인 서비스(BlindCandle 등)와 **같은 서버에 두지 않는다**.

## 1. 기본 설치

```bash
sudo apt-get update && sudo apt-get install -y git curl
# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v24.x
# 메모리 여유용 스왑 2GB (빌드 순간 피크 대비)
test -f /swapfile || (sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab)
```

## 2. Claude Code 설치와 구독 로그인

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude   # 처음 실행하면 로그인 안내
```

- 로그인 방식은 **Claude 구독 계정**을 고른다. API 키 방식이 아니다.
- 서버에는 브라우저가 없다. 화면에 나온 주소를 PC 브라우저에서 열고, 인증 코드를 터미널에 붙여 넣는다.
- `ANTHROPIC_API_KEY` 환경변수를 설정하지 않는다. 엔진이 지우긴 하지만 혼동을 막기 위해서다.
- 확인: `claude -p "say ok"` 가 응답하면 된다.

## 3. 시스템 설치와 회사 설립

```bash
git clone https://github.com/HEOSEONGILml/BusinessFactory.git ~/BusinessFactory
cd ~/BusinessFactory
npm install
npm test          # 모두 통과해야 한다
bin/bf init       # company/ 생성: 기본 직원 4명, 핸드북
```

`company/config.yaml` 을 서버에 맞게 고친다.

```yaml
notify:
  desktop: false            # 서버에는 Windows 알림이 없다
  ntfy_topic: <긴-무작위-이름>   # 휴대폰 알림 (ntfy 앱에서 같은 주제 구독). 원치 않으면 null
web:
  enabled: true
  port: 4300
  open_browser: false
```

`ntfy_topic` 은 아는 사람은 누구나 알림을 읽을 수 있다. 추측하기 어려운 긴 이름을 쓴다. 예: `bf-` + `openssl rand -hex 12` 의 출력.

## 4. 이전 PC의 회사 기억 옮기기 (선택)

GitHub 레포가 공개라서 회사 기억은 레포에 넣지 않았다. 이전 PC의 아래 파일을 서버의 같은 위치로 복사한다. VS Code 원격 탐색기로 끌어다 놓으면 된다.

- `company/memory/index.md`
- `company/memory/community-outreach.md`
- `company/memory/blindcandle.md`

복사한 뒤 `cd company && git add -A && git -c user.name=BusinessFactory -c user.email=bf@localhost commit -m "회사 기억 이관"`.

## 5. BlindCandle 작업 공간

```bash
cd ~/BusinessFactory
git clone https://github.com/HEOSEONGILml/trading-simulation.git workspaces/blindcandle
cd workspaces/blindcandle && git checkout feature/business && npm install && npm test
```

git에 없는 파일은 이전 PC에서 직접 복사한다. 이 파일들은 GitHub, 업무 이력, 메신저 어디에도 올리지 않는다.

- `workspaces/blindcandle/deploy/.env`: 비밀값
- (서버에서 배포까지 하려면) 배포용 SSH 키 `~/.ssh/trading_sim_deploy`. 복사한 뒤 `chmod 600`.

## 6. 상시 실행 (systemd)

```bash
sudo tee /etc/systemd/system/businessfactory.service >/dev/null <<'EOF'
[Unit]
Description=BusinessFactory (AI company engine + web console)
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/BusinessFactory
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node engine/src/cli.ts engine
Restart=on-failure
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=600

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now businessfactory
journalctl -u businessfactory -f     # 로그 보기
```

- `KillSignal=SIGINT` 와 `TimeoutStopSec=600`: 서비스를 멈출 때 진행 중인 직원 실행이 끝날 때까지 기다린다.
- 엔진의 켜짐/꺼짐은 웹 화면 버튼으로 바꾼다. 마지막 상태를 기억한다.

### 엔진 감시 (자동 재가동)

엔진이 멈추면 두 단계로 다시 가동한다.

- **안전장치 정지**(시스템 영역 변경, 인증 오류 등): 엔진이 `watchdog.auto_resume_minutes`(기본 10분) 뒤에 스스로 다시 가동하고 휴대폰으로 알린다. 연속으로 멈추면 20분, 40분… 으로 늘려 최대 6시간까지 기다린다. 웹 화면에서 직접 켜면 이 간격이 처음으로 돌아간다. 자동 재가동을 끄려면 `company/config.yaml` 에 `watchdog: { auto_resume_minutes: 0 }` 을 넣는다.
- **프로세스가 죽거나 응답이 없을 때**: 아래 타이머가 2분마다 `bf engine-check` 로 확인하고 서비스를 다시 시작한다. 엔진은 몇 초마다 `company/.engine-heartbeat.json` 을 갱신한다. `watchdog.stale_seconds`(기본 120초) 넘게 갱신이 없으면 멈춘 것으로 본다.

웹 화면의 "꺼짐" 버튼으로 끈 상태는 사용자의 선택이므로 다시 켜지 않는다.

```bash
sudo tee /etc/systemd/system/businessfactory-watchdog.service >/dev/null <<'UNIT'
[Unit]
Description=BusinessFactory engine watchdog

[Service]
Type=oneshot
ExecStart=/home/ubuntu/BusinessFactory/bin/bf-watchdog
UNIT
sudo tee /etc/systemd/system/businessfactory-watchdog.timer >/dev/null <<'UNIT'
[Unit]
Description=Check the BusinessFactory engine every 2 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now businessfactory-watchdog.timer
bin/bf engine-check                              # 엔진: 정상 (...)
journalctl -u businessfactory-watchdog -n 20     # 감시 기록
```

서비스를 일부러 멈춰 둘 때는 타이머도 함께 멈춘다: `sudo systemctl stop businessfactory-watchdog.timer businessfactory`

## 7. 웹 화면 접속

웹 화면은 서버의 127.0.0.1:4300 에서만 열린다. **Lightsail 방화벽에서 4300 포트를 절대 열지 않는다.** 로그인 기능이 없기 때문이다. 접속 방법은 아래 둘 중 하나다.

- **VS Code Remote-SSH 로 접속해 있을 때**: 하단 "포트" 탭에서 4300 을 전달(Forward)한다. 그다음 PC 브라우저에서 http://localhost:4300 을 연다.
- **SSH 터널**: PC에서 `ssh -L 4300:127.0.0.1:4300 ubuntu@<고정IP>` 를 실행한 뒤 http://localhost:4300 을 연다.

### 휴대폰·외부에서 접속 (Tailscale)

Tailscale 사설망 안에서만 열리는 HTTPS 주소를 만든다. 인터넷에는 열리지 않는다.

```bash
cd ~/BusinessFactory
bin/bf web-password                  # 웹 화면 로그인 암호 (8자 이상). 반드시 먼저 설정한다
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                    # 화면의 주소를 PC 브라우저에서 열어 로그인
sudo tailscale serve --bg 4300       # 처음이면 Serve 활성화 주소가 나온다. 브라우저에서 켜고 다시 실행
sudo tailscale serve status          # https://<서버이름>.<tailnet>.ts.net 주소 확인
```

`company/config.yaml` 의 `web.allowed_hosts` 에 그 주소의 호스트 이름을 넣고 서비스를 다시 시작한다.

```yaml
web:
  allowed_hosts:
    - <서버이름>.<tailnet>.ts.net
```

휴대폰과 PC에 Tailscale 앱을 깔고 같은 계정으로 로그인하면 그 주소로 접속된다. 암호를 끄려면 `bin/bf web-password --off`.

## 8. 첫 목표 다시 등록

웹 화면 목표 입력칸에 아래를 넣는다. 작업 공간은 `blindcandle`, 프로젝트도 `blindcandle` 로 고른다.

```
BlindCandle(작업 공간 blindcandle)을 인수받아 운영을 이어가라.
1. 작업 공간의 CLAUDE.md, PLAN.md, REQUEST.md, README.md와 회사 기억 blindcandle을 읽고 현재 상태를 파악해 output/plan.md에 정리한다.
2. 이 프로젝트의 개발을 맡을 직원이 필요하면 hr에게 채용을 맡긴다. 개발자는 sonnet 모델로 하고, 권한은 테스트·타입검사·빌드(npm)와 로컬 git 커밋 정도로 최소화한다. git push와 운영 배포는 매번 결재로 처리하게 한다.
3. REQUEST.md에 아직 '진행 중'인 사용자 요청은 사용자에게 건별로(--item) 묻는다. 비밀값은 사용자가 deploy/.env에 직접 넣도록 안내한다.
4. PLAN.md '이번 주 할 일' 중 사용자 없이 할 수 있는 개발 작업(미니앱 전환)을 진행한다.
```

## 9. Linux에서 확인할 것

- `ls -l bin/bf` 가 실행 가능(`-rwxr-xr-x`)이어야 한다. 아니면 직원이 `bf` 명령을 못 쓴다. 고치려면 `chmod +x bin/bf`.
- 엔진 로그에 `권한 거부`가 반복되면 해당 업무의 활동 기록(`board/<번호>/activity.log`)을 확인한다.
- `git push` 를 서버에서 하려면 GitHub 인증(gh CLI 또는 개인 액세스 토큰)이 필요하다. 직원의 push는 어차피 결재를 거친다.
