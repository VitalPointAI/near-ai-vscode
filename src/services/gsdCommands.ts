import * as vscode from 'vscode';
import { GSD_COMMANDS, GsdCommandDefinition, searchGsdCommands } from '../domain/gsdCommands';

export { GSD_COMMANDS } from '../domain/gsdCommands';
export { searchGsdCommands } from '../domain/gsdCommands';

export async function chooseGsdCommand(): Promise<GsdCommandDefinition | undefined> {
  const items = searchGsdCommands('').map((definition) => ({
    label: `${definition.category}  ${definition.title}`,
    description: `/${definition.command}`,
    detail: definition.description,
    definition
  }));
  const selected = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'Choose an Open-GSD command to continue with…'
  });
  return selected?.definition;
}
