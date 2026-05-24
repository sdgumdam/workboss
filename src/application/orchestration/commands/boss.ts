import {spawn} from 'child_process';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

import {
	isTmuxAvailable,
	workbossSessionExists,
	sendKeys,
	WORKBOSS_SESSION,
	LEFT_PANE,
	RIGHT_PANE,
	CliTmuxClient,
} from '../../../infrastructure/tmux/tmux.js';

import {ok, ensureServerUp} from './utils.js';
import {ORCHESTRATOR_STATE_FILE} from '../../../infrastructure/filesystem/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORCHESTRATOR_TEMPLATE = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'templates',
	'ORCHESTRATOR.md',
);

const SUPERVISOR_HOME = path.join(os.homedir(), '.workboss', 'supervisor');

export async function bossCmd(args: {
	agent?: 'opencode' | 'claude';
}): Promise<void> {
	await ensureServerUp();

	await fs.mkdir(SUPERVISOR_HOME, {recursive: true, mode: 0o700});
	const agent = args.agent ?? 'opencode';
	const docName = agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
	const promptContent = await fs.readFile(ORCHESTRATOR_TEMPLATE, 'utf8');
	await fs.writeFile(
		path.join(SUPERVISOR_HOME, docName),
		promptContent,
		'utf8',
	);

	const useTmux = await isTmuxAvailable();

	if (useTmux) {
		const exists = await workbossSessionExists();
		if (!exists) {
			const tmux = new CliTmuxClient();
			await tmux.createSplitLayout(SUPERVISOR_HOME);
		}

		const bootScan =
			'按 AGENTS.md 的"开机自检"段做一次：把机器上所有活着的 worker 和当前待审批用一段话扫完的格式汇报给我。然后等我下一步指令。';

		let cmd: string;
		if (agent === 'opencode') {
			cmd = `opencode --prompt '${bootScan}'`;
		} else {
			cmd = 'claude';
		}

		await sendKeys(LEFT_PANE, cmd);
		await sendKeys(RIGHT_PANE, 'workboss dashboard');

		await fs.writeFile(
			ORCHESTRATOR_STATE_FILE,
			JSON.stringify({agent, cwd: SUPERVISOR_HOME}),
			'utf8',
		);

		ok(`workboss boss: launching ${agent} in tmux session "${WORKBOSS_SESSION}"`);
		ok(`  left pane : orchestrator`);
		ok(`  right pane: dashboard`);
		ok('');

		const child = spawn('tmux', ['attach', '-t', WORKBOSS_SESSION], {
			stdio: 'inherit',
		});

		await new Promise<void>((resolve, reject) => {
			child.on('exit', code => {
				process.exitCode = code ?? 0;
				resolve();
			});
			child.on('error', err => {
				reject(
					new Error(
						`failed to attach to tmux: ${err.message}. Is tmux on your PATH?`,
					),
				);
			});
		});
		return;
	}

	ok(`workboss boss: launching ${agent} in ${SUPERVISOR_HOME}`);
	ok('');

	const bootScan =
		'按 AGENTS.md 的"开机自检"段做一次：把机器上所有活着的 worker 和当前待审批用一段话扫完的格式汇报给我。然后等我下一步指令。';
	const cliArgs =
		agent === 'opencode' ? ['--prompt', bootScan] : [];
	if (agent === 'claude') {
		ok(
			'(提示：claude 启动后第一句对它说"扫一遍"它就会自动跑 list+discover 汇报)',
		);
		ok('');
	}

	const child = spawn(agent, cliArgs, {
		cwd: SUPERVISOR_HOME,
		stdio: 'inherit',
	});

	await new Promise<void>((resolve, reject) => {
		child.on('exit', code => {
			process.exitCode = code ?? 0;
			resolve();
		});
		child.on('error', err => {
			reject(
				new Error(
					`failed to launch ${agent}: ${err.message}. ` +
						`Is "${agent}" on your PATH?`,
				),
			);
		});
	});
}
