import { createInterface } from "node:readline";
import process from "node:process";

export function promptVisible(
  label: string,
  nonInteractiveMessage = "Interactive prompt requires a terminal.",
): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) {
    throw new Error(nonInteractiveMessage);
  }
  const readline = createInterface({ input, output });
  return new Promise((resolve) => {
    readline.question(`${label}: `, (answer) => {
      readline.close();
      resolve(answer);
    });
  });
}
