import * as vscode from 'vscode';
import { braveSearch, SearchProvider, SearchProviderName, searxngSearch, tavilySearch } from '../agent/webSearch';

// Choosing and configuring the WebSearch provider. API keys live in SecretStorage; the provider
// and SearXNG address are ordinary settings.

const KEY = (provider: SearchProviderName) => `nearAi.webSearch.${provider}.apiKey`;

/** The configured provider, or undefined when search is off or not set up. */
export async function webSearchProvider(secrets: vscode.SecretStorage): Promise<SearchProvider | undefined> {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const provider = configuration.get<string>('webSearch.provider', 'off');
  try {
    if (provider === 'brave' || provider === 'tavily') {
      const key = await secrets.get(KEY(provider));
      return key ? (provider === 'brave' ? braveSearch(key) : tavilySearch(key)) : undefined;
    }
    if (provider === 'searxng') {
      const url = configuration.get<string>('webSearch.searxngUrl', '').trim();
      return url ? searxngSearch(url) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function registerWebSearchSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.setUpWebSearch', async () => {
    const teeOnly = vscode.workspace.getConfiguration('nearAi').get<string>('privacyMode') === 'tee-only';
    const choice = await vscode.window.showQuickPick([
      { label: 'SearXNG (self-hosted)', description: 'Open source; queries stay on a server you run', provider: 'searxng' as const },
      { label: 'Brave Search', description: 'Independent index; free tier; needs an API key', provider: 'brave' as const },
      { label: 'Tavily', description: 'Search built for AI research; needs an API key', provider: 'tavily' as const },
      { label: 'Turn web search off', provider: 'off' as const }
    ], { title: 'Web search for agents', placeHolder: teeOnly ? 'TEE-only mode is on: search queries go to the provider you choose, outside NEAR\'s TEE.' : 'Search queries go to the provider you choose.' });
    if (!choice) return;
    const configuration = vscode.workspace.getConfiguration('nearAi');
    if (choice.provider === 'off') { await configuration.update('webSearch.provider', 'off', vscode.ConfigurationTarget.Global); return; }
    if (choice.provider === 'searxng') {
      const url = await vscode.window.showInputBox({ title: 'SearXNG address', prompt: 'The base URL of your SearXNG instance, with the JSON format enabled (search.formats: [html, json] in settings.yml).', value: configuration.get<string>('webSearch.searxngUrl', ''), placeHolder: 'https://search.example.org', validateInput: (value) => { try { searxngSearch(value); return undefined; } catch (error) { return (error as Error).message; } } });
      if (!url) return;
      await configuration.update('webSearch.searxngUrl', url.trim(), vscode.ConfigurationTarget.Global);
    } else {
      const key = await vscode.window.showInputBox({ title: `${choice.label} API key`, prompt: `Stored in VS Code's encrypted secret storage. Get one at ${choice.provider === 'brave' ? 'https://brave.com/search/api/' : 'https://app.tavily.com'}.`, password: true, ignoreFocusOut: true, validateInput: (value) => (value.trim().length < 10 ? 'That does not look like an API key.' : undefined) });
      if (!key) return;
      await context.secrets.store(KEY(choice.provider), key.trim());
    }
    await configuration.update('webSearch.provider', choice.provider, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Agents can now search with ${choice.label}.${teeOnly ? ' Queries go to that provider, outside NEAR\'s TEE.' : ''}`);
  }));
}
