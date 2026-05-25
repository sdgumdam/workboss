import {promises as fs} from 'fs';
import path from 'path';

import {workerInboxPath} from '../../../infrastructure/filesystem/paths.js';
import {getAdapter} from '../agents/index.js';

import {ok, loadWorker, ensureServerUp} from './utils.js';

export async function messageWorker(name: string, text: string): Promise<void> {
	const meta = await loadWorker(name);
	const adapter = getAdapter(meta.agent);
	const stamp = new Date().toISOString();
	await fs.appendFile(
		workerInboxPath(name),
		`\n---\n[${stamp}] workboss:\n${text.trim()}\n`,
		'utf8',
	);
	ok(`appended message to ${workerInboxPath(name)}`);

	const docName = adapter.getBootstrapDocName();
	const docPath = path.join(meta.cwd, docName);
	const marker = `<!-- workboss:${name} -->`;
	let hasMarker = false;
	try {
		hasMarker = (await fs.readFile(docPath, 'utf8')).includes(marker);
	} catch {
	}
	if (hasMarker) return;

	const workbossServerUrl = await ensureServerUp();
	await adapter.prepareCwd({
		workerName: name,
		cwdAbs: meta.cwd,
		workbossServerUrl,
	});

	ok('');
	ok('⚠ 这是第一次给这个 worker 发消息。');
	ok(`  inbox 协议引导已写入 ${docPath}。`);
	ok(`  但 ${adapter.getDisplayName()} session 启动后不会重读这个文件 ——`);
	ok(`  当前对话窗的 worker 看不到这条消息。`);
	ok('  要让它真正接进 workboss 的 inbox / 权限流，请重启 worker：');
	for (const line of adapter.getRestartInstructions(meta)) {
		ok(`    ${line}`);
	}
	ok('  重启完之后这条 inbox 消息会在它的第一回合被读到。');
}
