// 필요한 모듈을 가져옵니다.
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http'); // WebSocket을 위해 http 서버 사용
const { WebSocketServer } = require('ws'); // WebSocket 서버
const SSH2Promise = require('ssh2-promise');

// --- 기본 설정 ---
const app = express();
const PORT = 3000;
const PROFILES_PATH = path.join(__dirname, 'profiles.json');
const TEMPLATE_PATH = path.join(__dirname, 'template.txt');

// --- 파일 초기화 로직 ---
try {
    if (!fs.existsSync(PROFILES_PATH)) {
        fs.writeFileSync(PROFILES_PATH, JSON.stringify([]));
        console.log(`[초기화] ${PROFILES_PATH} 생성`);
    }
    if (!fs.existsSync(TEMPLATE_PATH)) {
        fs.writeFileSync(TEMPLATE_PATH, '### 실행 결과 템플릿 ###');
        console.log(`[초기화] ${TEMPLATE_PATH} 생성`);
    }
} catch (error) {
    console.error(`[오류] 데이터 파일 생성 중 문제 발생:`, error);
    process.exit(1);
}

// --- 미들웨어 설정 ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- HTTP 서버 및 WebSocket 서버 설정 ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log('[정보] WebSocket 서버가 초기화되었습니다.');

// --- WebSocket 연결 핸들러 ---
wss.on('connection', ws => {
    console.log('[WebSocket] 클라이언트가 연결되었습니다.');

    // 클라이언트로부터 메시지 수신
    ws.on('message', async (message) => {
        try {
            const parsedMessage = JSON.parse(message);

            // 'execute' 타입의 메시지만 처리
            if (parsedMessage.type === 'execute') {
                const selectedProfiles = parsedMessage.profiles;
                if (!Array.isArray(selectedProfiles) || selectedProfiles.length === 0) {
                    ws.send(JSON.stringify({ type: 'system-error', message: '실행할 프로필이 선택되지 않았습니다.' }));
                    return;
                }
                
                console.log(`[WebSocket] ${selectedProfiles.length}개의 프로필 작업 시작...`);
                
                // 모든 프로필 작업을 병렬로 실행
                await Promise.allSettled(selectedProfiles.map(profile => 
                    executeProfile(profile, ws)
                ));
                
                console.log(`[WebSocket] 모든 프로필 작업 스트림이 시작/종료되었습니다.`);
                ws.send(JSON.stringify({ type: 'system-done', message: '모든 작업 완료' }));
            }

        } catch (error) {
            console.error('[WebSocket] 메시지 처리 오류:', error);
            ws.send(JSON.stringify({ type: 'system-error', message: `잘못된 요청 형식입니다: ${error.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] 클라이언트 연결이 종료되었습니다.');
    });

    ws.on('error', (error) => {
        console.error('[WebSocket] 오류 발생:', error);
    });
});

/**
 * [수정됨]
 * 개별 프로필을 실행하고 WebSocket으로 결과를 스트리밍하는 함수
 * 스트리밍 관련 오류가 계속 발생하므로, "맨 처음 코드"에서 사용된 안정적인
 * 'await ssh.exec(command)' 방식으로 되돌립니다.
 * 이 방식은 전체 결과를 한 번에 받아와서 WebSocket으로 한 번에 전송합니다.
 * * @param {object} profile - 실행할 프로필 객체
 * @param {WebSocket} ws - 통신할 WebSocket 클라이언트
 */
async function executeProfile(profile, ws) {
    // 작업 시작 알림
    ws.send(JSON.stringify({ type: 'start', profileId: profile.id, profileName: profile.name }));

    let ssh;
    let isConnected = false;

    try {
        const sshInfoParts = profile.sshInfo.split('@');
        if (sshInfoParts.length !== 2 || !sshInfoParts[0] || !sshInfoParts[1]) {
            throw new Error(`잘못된 SSH 정보 형식입니다. ("user@host" 필요)`);
        }
        const [username, host] = sshInfoParts;

        // --- SSH 설정: 키 인증 / 비밀번호 인증 분기 로직 강화 ---
        const sshConfig = { host, username };
        
        if (profile.authType === 'key') {
            if (!profile.privateKeyPath || profile.privateKeyPath.trim() === '') {
                 throw new Error(`'SSH 키' 인증 방식이나, 키 파일 경로가 비어있습니다.`);
            }
            if (!fs.existsSync(profile.privateKeyPath)) {
                throw new Error(`SSH 키 파일을 찾을 수 없습니다: ${profile.privateKeyPath}`);
            }
            sshConfig.privateKey = fs.readFileSync(profile.privateKeyPath);
            console.log(`[${profile.name}] SSH 키(${profile.privateKeyPath})로 연결 시도...`);
        } 
        else {
            console.log(`[${profile.name}] '비밀번호'로 연결 시도...`);
            sshConfig.password = profile.password;
        }
        // --- ---
        
        // --- [신규] SSH 터널링(Hop) 설정 ---
        if (profile.useTunnel && profile.tunnelSshInfo) {
            console.log(`[${profile.name}] SSH 터널링 사용: ${profile.tunnelSshInfo}`);
            const tunnelInfoParts = profile.tunnelSshInfo.split('@');
            if (tunnelInfoParts.length !== 2 || !tunnelInfoParts[0] || !tunnelInfoParts[1]) {
                throw new Error(`잘못된 터널 SSH 정보 형식입니다. ("user@host" 필요)`);
            }
            const [tunnelUser, tunnelHost] = tunnelInfoParts;

            const hopConfig = {
                host: tunnelHost,
                username: tunnelUser
            };

            if (profile.tunnelAuthType === 'key') {
                if (!profile.tunnelKeyPath || profile.tunnelKeyPath.trim() === '') {
                     throw new Error(`'터널 SSH 키' 인증 방식이나, 키 파일 경로가 비어있습니다.`);
                }
                if (!fs.existsSync(profile.tunnelKeyPath)) {
                    throw new Error(`터널 SSH 키 파일을 찾을 수 없습니다: ${profile.tunnelKeyPath}`);
                }
                hopConfig.privateKey = fs.readFileSync(profile.tunnelKeyPath);
                console.log(`[${profile.name}] 터널(${profile.tunnelKeyPath}) 키로 연결 시도...`);
            } else {
                console.log(`[${profile.name}] 터널 '비밀번호'로 연결 시도...`);
                hopConfig.password = profile.tunnelPassword;
            }
            
            sshConfig.hop = hopConfig; // ssh2-promise에 hop 설정 추가
        }
        // --- ---

        ssh = new SSH2Promise(sshConfig);
        await ssh.connect();
        isConnected = true;
        console.log(`[${profile.name}] SSH 연결 성공.`);

        const pathsToRead = profile.path.split(',').map(p => p.trim()).filter(p => p).join(' ');
        if (!pathsToRead) {
            throw new Error("조회할 경로가 지정되지 않았습니다.");
        }

        let excludeArgs = '';
        if (profile.exclude && profile.exclude.trim() !== '') {
            const excludePatterns = profile.exclude.split(',').map(p => p.trim()).filter(p => p);
            excludeArgs = excludePatterns.map(pattern => `-not -path '${pattern}'`).join(' ');
        }

        const command = `
for path in ${pathsToRead}; do
  if [ -e "$path" ]; then
    find "$path" ${excludeArgs} -type f -exec sh -c 'echo "\\n--- File: {} (Profile: ${profile.name}) ---"; cat "{}" 2>/dev/null; echo ""' \\;
  else
    echo "\\n--- Error: Path not found: $path (Profile: ${profile.name}) ---";
  fi
done
`;

        console.log(`[${profile.name}] 명령어 실행: find...`);
        
        // --- [수정됨] 맨 처음 코드의 안정적인 방식으로 복귀 ---
        // ssh.exec(command)는 전체 결과(stdout)를 문자열로 반환합니다.
        // stderr가 발생하면 오류를 throw합니다.
        const fullResult = await ssh.exec(command);
        // --- [수정 완료] ---

        // 전체 결과를 한 번의 'data' 메시지로 전송
        ws.send(JSON.stringify({
            type: 'data',
            profileId: profile.id,
            chunk: fullResult.toString('utf8') // fullResult가 Buffer일 수 있으므로 toString
        }));

        // 즉시 완료 메시지 전송
        ws.send(JSON.stringify({ type: 'done', profileId: profile.id }));
        console.log(`[${profile.name}] 작업 완료 및 결과 전송.`);


    } catch (sshError) {
        // ssh.exec가 오류(stderr)를 반환했거나, 연결/명령어 실행 전 오류
        console.error(`[${profile.name}] SSH 작업 실패:`, sshError.message);
        
        // sshError.message에 stderr 출력이 포함될 수 있습니다.
        const errorMessage = sshError.message || "알 수 없는 오류 발생";
        
        ws.send(JSON.stringify({
            type: 'error',
            profileId: profile.id,
            // 오류 메시지를 'chunk'로 보내서 <pre>에 표시
            message: `오류 발생: ${errorMessage}`
        }));
    } finally {
        // 작업이 성공하든, 실패하든(catch), 항상 연결을 닫아줍니다.
        if (isConnected && ssh && ssh.close) {
            console.log(`[${profile.name}] SSH 연결 종료.`);
            try { await ssh.close(); } catch(e) { /* 이미 닫혔을 수 있음 */ }
        }
    }
}


// --- 기존 API 엔드포인트 (프로필, 템플릿) ---

app.get('/api/profiles', (req, res) => {
    fs.readFile(PROFILES_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ message: '프로필 읽기 오류' });
        try {
            res.json(JSON.parse(data));
        } catch (parseErr) {
            res.status(500).json({ message: '프로필 JSON 파싱 오류' });
        }
    });
});

app.post('/api/profiles', (req, res) => {
    const newProfiles = req.body;
    fs.writeFile(PROFILES_PATH, JSON.stringify(newProfiles, null, 2), 'utf8', (err) => {
        if (err) return res.status(500).json({ message: '프로필 저장 오류' });
        res.status(200).json({ message: '프로필이 저장되었습니다.' });
    });
});

app.get('/api/template', (req, res) => {
    fs.readFile(TEMPLATE_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ message: '템플릿 읽기 오류' });
        res.type('text/plain').send(data);
    });
});

app.post('/api/template', (req, res) => {
    const { template } = req.body;
    fs.writeFile(TEMPLATE_PATH, template, 'utf8', (err) => {
        if (err) return res.status(500).json({ message: '템플릿 저장 오류' });
        res.status(200).json({ message: '템플릿이 저장되었습니다.' });
    });
});

// --- 루트 경로 ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 서버 실행 (app.listen 대신 server.listen) ---
server.listen(PORT, () => {
    console.log(`[정보] SSH 원격 파일 뷰어 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

