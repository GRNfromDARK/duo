export function buildContinuedTaskPrompt(
  currentTask: string,
  followUpRequirement: string,
): string {
  return [
    currentTask,
    '',
    'Additional user requirement:',
    followUpRequirement.trim(),
  ].join('\n');
}
