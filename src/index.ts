import execa, { ExecaError } from 'execa';
import fs from 'fs-extra';
import ora from 'ora';
import path from 'path';
import which from 'which';
import { v4 as uuidv4 } from 'uuid';
import { Options, Terminals, Terminal } from '~/types';

const COMMAND = '([{<COMMAND>}])';
const spinner = ora();

export const defaultOptions: Options = {
  commandTemplate: COMMAND,
  cwd: process.cwd(),
  terminals: {
    darwin: [
      ['osascript', '-e', `tell app "Terminal" to do script "${COMMAND}"`]
    ],
    linux: [
      ['gnome-terminal', '--', 'sh', '-c', COMMAND],
      ['xterm', '-e', `sh -c "${COMMAND}"`],
      ['konsole', '-e', `sh -c "${COMMAND}"`],
      ['terminator', '-u', '-e', `sh -c "${COMMAND}"`]
    ]
  }
};

async function getDefaultTerminalCommand(): Promise<string | undefined> {
  try {
    const REGEX = /[^/]+$/g;
    const terminalPath = await fs.realpath(await which('x-terminal-emulator'));
    const command = [...(terminalPath.match(REGEX) || [])]?.[0];
    return command;
  } catch (err: any) {
    if (err.message.indexOf('not found') > -1) return undefined;
    throw err;
  }
}

function createSafeCommand(uid: string, command: string) {
  if (process.platform === 'darwin') {
    command = `cd ${process.cwd()} && ${command}`;
  }
  return `node ${path.resolve(__dirname, '../lib/shb64')} ${Buffer.from(
    command
  ).toString('base64')} open-terminal:uid:${uid}`;
}

async function hasTerminal(terminal: Terminal | string) {
  const command = Array.isArray(terminal) ? terminal?.[0] || '' : terminal;
  try {
    await which(command);
    return true;
  } catch (err: any) {
    if (err.message.indexOf('not found') > -1) return false;
    throw err;
  }
}

export default async function openTerminal(
  command: string | string[],
  options?: Partial<Options>
) {
  return openDefaultTerminal(command, options);
}

async function openDefaultTerminal(
  command: string | string[],
  options?: Partial<Options>,
  _terminals?: Terminal[],
  _i = 0
) {
  const uid = uuidv4();
  const fullOptions = mergeDefaults(options);
  if (!_terminals) {
    const terminals = fullOptions.terminals[process.platform];
    if (!terminals) {
      throw new Error(`operating system ${process.platform} not supported`);
    }
    const defaultTerminalCommand = await getDefaultTerminalCommand();
    _terminals = terminals.sort((a: Terminal) => {
      if ((a[0] || '').indexOf(defaultTerminalCommand || '') > -1) return -1;
      return 1;
    });
  }
  const safeCommand = createSafeCommand(
    uid,
    (Array.isArray(command) ? command : [command]).join(' ')
  );
  const terminal = _terminals[_i];
  if (!terminal) {
    spinner.warn(
      `running process in background because terminal could not be found
try installing on of the following terminals to run correctly: ${_terminals
        .map((terminal: Terminal) => terminal[0])
        .join(', ')}
`
    );
    const result = await execa(safeCommand, {
      cwd: fullOptions.cwd,
      shell: true,
      stdio: 'inherit'
    });
    return result;
  }
  if (!(await hasTerminal(terminal))) {
    return openDefaultTerminal(command, options, _terminals, ++_i);
  }
  try {
    await tryOpenTerminal(uid, terminal, safeCommand, fullOptions);
    return process.exit();
  } catch (err) {
    const error: any = err;
    if (error.command && error.failed) {
      return openDefaultTerminal(command, options, _terminals, ++_i);
    }
    throw err;
  }
}

async function tryOpenTerminal(
  uid: string,
  terminal: Terminal,
  command: string | string[],
  options?: Options
) {
  const { commandTemplate, cwd } = mergeDefaults(options);
  const [cmd] = terminal;
  if (!cmd) {
    throw new Error(`terminal ${terminal[0]} not found`);
  }
  const [, ...args] = terminal.map((arg: string) =>
    arg.replace(
      commandTemplate,
      Array.isArray(command) ? command.join(' ') : command
    )
  );
  const p = execa(cmd, args, {
    stdio: 'inherit',
    cwd
  });
  await new Promise((r) => setTimeout(r, 1000));
  await waitOnTerminal(uid);
  const result = await p;
  process.on('SIGINT', () => {
    process.exit();
  });
  process.on('SIGTERM', () => {
    process.exit();
  });
  return result;
}

async function waitOnTerminal(
  uid: string,
  pollInterval = 3000,
  timeout?: number
) {
  await new Promise((r) => setTimeout(r, pollInterval));

  return waitOnTerminal(
    uid,
    timeout,
    typeof timeout === 'undefined' ? timeout : timeout - pollInterval
  );
}

function mergeDefaults(options?: Partial<Options>): Options {
  return {
    ...defaultOptions,
    ...(options || {}),
    terminals: {
      ...defaultOptions.terminals,
      ...Object.entries(options?.terminals || {}).reduce(
        (osTerminals: Terminals, [os, terminals]: [string, Terminal[]]) => {
          osTerminals[os] = (terminals || []).reduce(
            (terminals: Terminal[], terminal: Terminal) => {
              if (
                !terminals.find((existingTerminal: Terminal) => {
                  return existingTerminal[0] === terminal[0];
                })
              ) {
                terminals.push(terminal);
              }
              return terminals;
            },
            []
          );
          return osTerminals;
        },
        {}
      )
    }
  };
}

export * from '~/types';
