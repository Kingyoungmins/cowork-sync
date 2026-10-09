# cowork-sync

cowork-sync는 여러 클론에 걸쳐 git 브랜치 하나의 작업 트리를 실시간으로 맞춰 주는
Claude Code 플러그인입니다. 팀원은 각자 자기 PC의 자기 클론에서, 각자 자기
Claude Code 세션으로 일합니다. 누군가 파일을 저장하면 그 변경이 다른 모든 사람의
작업 트리에 전달됩니다. 전달 경로는 프로젝트 자체의 git 원격 저장소뿐이며, 별도
서버는 없습니다.

cowork-sync는 소스 공개형(source-available) 개인 프로젝트입니다. 어떤 회사나
고용주와도 제휴, 후원, 보증 관계가 없습니다. 라이선스는 FSL-1.1-ALv2이며
([LICENSE.md](LICENSE.md) 참고), 기여하려면 [CONTRIBUTING.md](CONTRIBUTING.md)에
설명된 CLA가 필요합니다.

## 상태: v0.1.0-preview

초기 미리보기 버전이며 완성된 제품이 아닙니다. 지금 동작하는 것은 동기화
엔진입니다. 클론마다 백그라운드 프로세스(데몬) 하나가 저장된 수정 내용을 감지해
원격 저장소에 올리고, 팀원의 수정 내용을 내 작업 트리에 써 넣습니다. 실제 GitHub
저장소에 클론 두 개를 두고 시험했습니다. 서로 다른 파일을 고친 경우, 같은 파일의
10줄 떨어진 곳을 고친 경우, 같은 줄을 고친 경우 모두 두 클론이 같은 상태로
끝났고, 이력도 fast-forward 한 줄이었습니다. 팀의 활동을 브라우저에 보여 주는
읽기 전용 뷰어의 핵심 부분도 들어 있습니다. 아직 들어 있지 않은 것은 다음과
같습니다. 충돌 보류(hold) UX(밀려난 버전은 보관되지만 이를 보거나 되살리는
명령은 없습니다), 함수 단위 선점(claim), Claude Code 세션 훅과 Claude 간
협업(이 미리보기에서 Claude는 동기화를 알지 못하며, Claude의 수정도 다른 저장된
파일과 똑같이 동기화됩니다), 전체 명령줄(save, doctor, 비공개 원격 저장소 확인
같은 시작 시 점검, 일시 정지와 재개), 그리고 뷰어 2(6개 언어, 녹화, 하이라이트
모음)입니다. 미리보기는 반드시 테스트용 저장소에서만 사용하세요.
무엇이 끝났고 무엇이 다음인지는 [docs/STATUS.md](docs/STATUS.md)에 있습니다.

## 요구 사항

- Claude Code 2.1.270 이상.
- `PATH`에 Node.js 20 이상 (소스에서 빌드하려면 20.6 이상).
- git 2.43 이상. 시작(start) 시 더 낮은 git은 거부합니다.
- Windows, macOS 또는 Linux.
- 사용자 지정 ref(`refs/cowork/*`)를 받아 주고 `--force-with-lease`를 실제로
  적용하는 **비공개** git 원격 저장소. GitHub는 둘 다 됩니다. 시작할 때 호스트를
  확인해 보고, 맞지 않으면 거부합니다.
- git 자격 증명 도우미(credential helper)에서 가져오는 자격 증명. cowork-sync는
  git의 입력 요청을 꺼 두기 때문에, 자격 증명이 없으면 멈춰 버리는 대신 분명한
  거부 메시지가 나옵니다.

## 설치

참여하는 모든 PC에 플러그인을 설치하고, 각자 저장소의 자기 클론을 가지고 있어야
합니다.

Claude Code 세션에서:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

또는 셸에서:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

`/reload-plugins`를 실행하거나 Claude Code를 다시 시작하면 플러그인이 로드됩니다.
이 마켓플레이스는 자동으로 업데이트되지 않습니다. 업데이트하려면
`/plugin marketplace update cowork-sync`를 실행한 뒤
`claude plugin update cowork-sync@cowork-sync`를 실행하세요. 플러그인을 지우려면
`claude plugin uninstall cowork-sync@cowork-sync`를 실행하세요.

## 사용법

내 클론에서 Claude Code를 열고 아래 명령을 입력합니다. Claude Code는 플러그인의
명령 이름을 `/cowork-sync:cowork`로 붙이므로, 이 이름을 전부 입력하세요. 같은
동작을 터미널에서도 `node "<플러그인 폴더>/dist/cli.js" <동작>` 형태로 실행할 수
있으며, `/cowork-sync:cowork view`가 그 경로를 출력해 줍니다.

| 명령 | 하는 일 |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | 이 저장소의 현재 브랜치에서 동기화를 시작합니다. 첫 번째 PC가 원격 저장소에 공용 보드를 만들고, 이후의 PC는 그 보드에 참여합니다. 데몬은 백그라운드에서 계속 실행됩니다. |
| `/cowork-sync:cowork status` | 짧은 요약을 출력합니다. 상태(`ok`, `degraded`, `offline`, `frozen`, `down` 등), 브랜치, 아직 올리거나 반영하지 못한 것을 보여 줍니다. |
| `/cowork-sync:cowork view` | 읽기 전용 뷰어를 여는 명령을 출력합니다. 뷰어는 터미널에서만 열립니다. 출력된 명령을 터미널에서 실행하면 브라우저에서 열립니다. 아직 뷰어 프로세스가 없는 빌드라면 `RF_VIZ_START_FAILED`로 거부합니다([CHANGELOG.md](CHANGELOG.md) 참고). |
| `/cowork-sync:cowork stop` | 데몬을 깔끔하게 멈춥니다. 내 파일은 그대로 남습니다. |
| `/cowork-sync:cowork help` | 명령 목록을 보여 줍니다. |

명령이 거부될 때는 코드가 붙은 이유와, 실행할 명령이 적힌 `next:` 줄을 출력합니다.
데몬 자체가 시작을 거부하면 `the daemon did not start; it said:` 뒤에 데몬이 직접
남긴 줄이 이어집니다.

`start`가 확인하는 것:

- 메인 클론에서 실행해야 합니다. 연결된 워크트리(linked worktree)나 서브모듈은
  거부합니다.
- 브랜치가 체크아웃되어 있고, 원격 저장소에 존재하며, 원격보다 앞서거나 뒤처지지
  않아야 합니다. 먼저 push 또는 pull 하세요. 병합(merge)이나 리베이스(rebase)가
  진행 중이어도 안 됩니다.
- 원격의 fetch URL과 push URL이 같아야 하고, `insteadOf` 재작성이 적용되지
  않아야 합니다.
- 클론마다 데몬은 하나만 실행됩니다.
- 처음 시작할 때 커밋하지 않은 변경이 있으면 멈추고 선택을 요청합니다. 팀과
  공유할지, 이 PC에만 둘지 고르세요.

동기화가 실행되는 동안:

- 평소처럼 파일을 저장하세요. 저장한 수정은 게시되고, 팀원의 수정은 내 파일에
  써집니다.
- 동기화 중인 클론에서 `HEAD`를 움직이는 git 명령(commit, switch, checkout, pull,
  merge, rebase, stash)은 실행하지 마세요. `HEAD`가 원래 위치로 돌아올 때까지
  동기화가 얼어붙습니다(freeze). 먼저 동기화를 멈추세요.
- 공유 작업을 브랜치의 커밋으로 만들어 주는 `save` 단계는 아직 없습니다. 이는
  전체 명령줄과 함께 들어옵니다. 미리보기는 테스트 브랜치에서 실시간 동기화를
  체험해 보는 용도로 생각하세요.

각 클론은 자기 파일을 `.git/cowork/` 아래에 보관합니다. `status.json`(현재 상태)과
`log/daemon-0.jsonl`(데몬 로그)입니다.

## 동작 방식

1. 클론마다 데몬이 하나씩 실행됩니다. 데몬은 자기만의 비공개 git 인덱스로 내가
   저장한 파일을 읽으며, 내 인덱스는 건드리지 않습니다.
2. 공유 상태는 원격 저장소의 사용자 지정 ref 두 개에 있습니다.
   `refs/cowork/<branch>/board`는 fast-forward만 허용되는 보드 커밋 체인으로,
   기준(권위)이 되는 쪽입니다. `refs/cowork/<branch>/code`는 가장 최근 공유
   트리의 미러입니다. 이 ref에서 브랜치 이름은 퍼센트 인코딩됩니다.
3. 모든 push는 리스(lease, `--force-with-lease`)로 보호되는 fast-forward 입니다.
   그래서 어떤 PC도 다른 PC의 갱신을 덮어쓸 수 없습니다. 진 쪽은 다시 fetch 한
   뒤 재시도합니다. 팀 전체 예산(분당 push 12회, 제한이 걸린 뒤 30분 동안은 6회)
   으로 호스트에 가는 부하를 낮게 유지합니다.
4. 들어오는 변경은 명시적인 병합 기준(merge base)을 지정해 `git merge-tree`로
   병합합니다.
5. 파일은 데몬이 마지막으로 읽은 바이트 그대로일 때만 써집니다. 그래서 방금
   저장한 내 수정이 덮어써지는 일은 없습니다. 파일 묶음은 전부 쓰거나 전혀 쓰지
   않습니다.
6. 두 사람이 같은 줄을 바꾸면 한 버전이 이기고, 다른 버전은 내 클론에 보류(hold)
   기록으로 보관됩니다. 버려지는 일은 없습니다.
7. 설정, 훅, CI 파일(`.claude/`, `.github/workflows/`, `.gitattributes` 등)은
   실시간으로 동기화되지 않습니다. 보드의 이력이 다시 쓰이는 일이 생기면, 복구될
   때까지 모든 PC가 얼어붙습니다.
8. 미리보기는 내 브랜치(`refs/heads/<branch>`)에 절대 push 하지 않습니다. 일반
   `git fetch`는 사용자 지정 ref를 내려받지 않으므로, 평소의 git 이력은 깨끗하게
   유지됩니다.

## 안전 수칙

- cowork-sync는 내 작업 트리에 파일을 쓰며, 팀원의 수정도 마찬가지입니다. 먼저
  테스트 저장소에서 시험해 보고, 소중한 것은 백업해 두세요.
- **비공개** 원격 저장소만 사용하세요. 동기화 중인 클론에서 저장하는 모든 내용이
  `refs/cowork/*`로 push 되며, 저장소를 읽을 수 있는 사람은 누구나 그것을 가져갈
  수 있습니다. 미리보기는 원격이 비공개인지 아직 확인하지 않습니다.
- 비밀 정보처럼 보이는 이름의 새 파일(`.env`, `*.pem`, `*.key`, `id_rsa*`,
  `*credentials*` 등)은 공유되지 않습니다. 파일 내용에서 비밀 정보를 찾아내는
  검사는 아직 없으므로, 동기화되는 파일에 비밀 정보를 넣지 마세요.
- 1 MiB를 넘는 새 파일은 공유되지 않고, 50 MiB 이상인 파일은 실시간으로 동기화되지
  않습니다.
- 동기화를 멈추거나 플러그인을 지워도 원격 저장소의 사용자 지정 ref는 남습니다.
  모든 PC가 멈춘 뒤에 직접 지울 수 있습니다. 예:
  `git push origin --delete refs/cowork/main/board refs/cowork/main/code`.

## 라이선스

cowork-sync는 Functional Source License 1.1이며, 미래 라이선스로 Apache License
2.0을 적용합니다(FSL-1.1-ALv2, [LICENSE.md](LICENSE.md)). 요약하면, 경쟁 목적의
사용을 제외한 모든 목적으로 사용, 복사, 수정, 공유할 수 있습니다. 경쟁 목적의
사용이란 이 소프트웨어, 또는 본질적으로 같은 일을 하는 것을 상용 제품이나
서비스로 다른 사람에게 제공하는 것을 뜻합니다. 내부 사용, 교육, 연구, 그리고
라이선스를 받은 사람을 위한 전문 서비스는 허용됩니다. 각 릴리스는 공개된 지 2년
뒤부터 Apache License 2.0으로 이용할 수 있게 됩니다.

기여하려면 [CLA.md](CLA.md)의 기여자 라이선스 계약(CLA)이 필요합니다. 서명하는
방법과 코드 작업 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

## 문의

질문: minzbusiness0204@gmail.com. 보안 문제는 이메일이 아니라 저장소의 비공개
취약점 신고(private vulnerability reporting)로 알려 주세요.
[SECURITY.md](SECURITY.md)를 보세요.
