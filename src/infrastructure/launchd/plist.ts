import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import os from 'os';
import {LAUNCHD_PLIST_PATH, LAUNCHD_LABEL, SERVER_LOG_FILE} from '../filesystem/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function plistContent(nodePath: string, entryPath: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${entryPath}</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${SERVER_LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${SERVER_LOG_FILE}</string>
    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}</string>
        <key>HOME</key>
        <string>${os.homedir()}</string>
    </dict>
</dict>
</plist>
`;
}

export async function ensurePlist(): Promise<string> {
	const entryPath = path.join(__dirname, '..', '..', 'application', 'daemon', 'main.js');
	const content = plistContent(process.execPath, entryPath);
	await fs.mkdir(path.dirname(LAUNCHD_PLIST_PATH), {recursive: true});
	await fs.writeFile(LAUNCHD_PLIST_PATH, content, 'utf8');
	return LAUNCHD_PLIST_PATH;
}
