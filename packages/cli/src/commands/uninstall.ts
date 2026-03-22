import pc from 'picocolors';

export async function uninstallCommand(): Promise<void> {
  const lines = [
    '',
    `  ${pc.bold('Uninstall Spaghetti')}`,
    '',
    `  ${pc.dim('1.')} Remove the CLI:`,
    `     ${pc.cyan('npm uninstall -g @vibecook/spaghetti')}`,
    '',
    `  ${pc.dim('2.')} Remove cached data ${pc.dim('(optional)')}:`,
    `     ${pc.cyan('rm -rf ~/.spaghetti')}`,
    '',
    `  ${pc.dim('This removes:')}`,
    `    ${pc.dim('•')} spaghetti and spag commands`,
    `    ${pc.dim('•')} ~/.spaghetti/cache/spaghetti.db`,
    `    ${pc.dim('•')} ~/.spaghetti/update-check.json`,
    '',
    `  ${pc.dim('Your Claude Code data (~/.claude) is NOT affected.')}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
