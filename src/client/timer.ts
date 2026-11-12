// The harness has no process of its own: a timer of the system runs `reins tick run`. This is the
// text of such a timer for the human, for the three common timers. The harness writes no file of
// the system and starts nothing: the human puts the text where the system reads it.
// Specification: docs/spec/harness-manifest, the page of the triggers.

import os from 'node:os';
import path from 'node:path';

export type TimerText = {
  minutes: number;
  command: string[];
  launchd: { file: string; text: string; load: string };
  systemd: { dir: string; service: string; timer: string; load: string };
  cron?: string;
};

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// One word of a command line of a shell or of a unit of systemd.
const quote = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// `cli`: the file of the command line. `cwd`: the directory of the project whose schedule runs.
// `env`: the variables that the run needs: the path of the programs, and the config when the call names one.
export function timerText(minutes: number, cli: string, cwd: string, env: Record<string, string>): TimerText {
  const command = [process.execPath, cli, 'tick', 'run'];
  const vars = Object.entries(env);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>io.reins.tick</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map((word) => `    <string>${xml(word)}</string>`),
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${minutes * 60}</integer>`,
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(cwd)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...vars.flatMap(([name, value]) => [`    <key>${xml(name)}</key>`, `    <string>${xml(value)}</string>`]),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.reins.tick.plist');
  const line = command.map(quote).join(' ');
  // systemd reads `%` as the start of a specifier: a plain one is written twice.
  const unit = (s: string): string => s.replace(/%/g, '%%');
  const service = ['[Unit]', 'Description=reins: the schedule of the harness', '', '[Service]', 'Type=oneshot', `WorkingDirectory=${unit(cwd)}`, ...vars.map(([name, value]) => `Environment=${unit(quote(`${name}=${value}`))}`), `ExecStart=${unit(line)}`, ''].join('\n');
  const timer = ['[Unit]', 'Description=reins: the timer of the schedule', '', '[Timer]', `OnBootSec=${minutes}min`, `OnUnitActiveSec=${minutes}min`, '', '[Install]', 'WantedBy=timers.target', ''].join('\n');
  const out: TimerText = {
    minutes,
    command,
    launchd: { file, text: plist, load: `launchctl load ${quote(file)}` },
    systemd: { dir: path.join(os.homedir(), '.config', 'systemd', 'user'), service, timer, load: 'systemctl --user enable --now reins-tick.timer' },
  };
  // cron counts from the start of the hour or of the day: it keeps a period only when the period
  // divides the hour, or is whole hours that divide the day. Another period has no cron line.
  // cron reads `%` in a command as the end of a line: it is written with a backslash.
  const sets = vars.map(([name, value]) => `${name}=${quote(value)}`).join(' ');
  const run = `cd ${quote(cwd)} && ${sets === '' ? '' : `${sets} `}${line}`.replace(/%/g, '\\%');
  if (minutes < 60 && 60 % minutes === 0) out.cron = `*/${minutes} * * * * ${run}`;
  else if (minutes === 60) out.cron = `0 * * * * ${run}`;
  else if (minutes % 60 === 0 && minutes < 1440 && 24 % (minutes / 60) === 0) out.cron = `0 */${minutes / 60} * * * ${run}`;
  else if (minutes === 1440) out.cron = `0 0 * * * ${run}`;
  return out;
}
