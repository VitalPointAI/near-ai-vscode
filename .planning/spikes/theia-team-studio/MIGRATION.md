# Move NEAR AI development to Theia

The browser container is the development and acceptance target. Use the existing VSIX in a pinned Theia compatibility host to bring current workflows across while native ports are built. Keep the TypeScript engine and project files shared. Cut over to Theia as the sole development target after the workflows below pass end to end.

The [roadmap](../../ROADMAP.md) already calls for a VSIX bridge in L1b and native Team Studio, chat, and board in L6. Start the browser migration now. The appliance release keeps its hardware and offline deployment prerequisites.

| Area | Work and acceptance |
| --- | --- |
| Activation and setup | Load the latest released VSIX in the Theia compatibility host. Confirm activation for a clean workspace and an existing project. Complete onboarding and project/profile switching. Verify commands, settings, welcome content, and webview asset loading. |
| Project, team, and workspace UI | Exercise Team Studio, Team Live, board, activity, project configuration, and memory with existing project files. Confirm read, validation, save, reopen, cancellation, and project switching. The native Team Studio preview exercises parser reuse and read-only synthetic projects. |
| Chat and agent controls | Check the extension sidebar and chat command, history, steering, pause, resume, approvals, emergency stop, and reports. Replace unsupported host chat entry points with the native view as needed. Use deterministic providers or mocks for parity checks. |
| Accounts and integrations | Verify provider profiles, OAuth callbacks, secrets after restart, sync and recovery, offline/online hosting, model selection, spending controls, web search, and MCP. Preserve the product's authorization and secret storage contracts under the new host. |
| Staff and governance | Verify Staff Room, roster and project membership, approvals and decision records, policy editing and enforcement, labels, and audit history in an isolated sample project. |
| Compliance and exports | Verify the security posture panel, evidence views and exports, analytics, and SA&A package generation and downloads using synthetic inputs. Verify that unsupported controls and missing evidence are identified accurately. |
| Cutover | Record each contributed command and UI flow as verified through the compatibility host, verified natively, or blocked with a tracked fix. Verify local container startup, existing project compatibility, restart persistence, and the release pipeline before retiring the VS Code development target. |

Run each group against the actual browser container. Installed and registered commands are only the activation check. A workflow requires a browser test through its normal entry point and the same outcome as the supported extension.
