import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Utils from './utils';
import * as nls from 'vscode-nls';
import { languageClient, totvsStatusBarItem } from './extension';
import { inputConnectionParameters } from './inputConnectionParameters';
import { inputAuthenticationParameters } from './inputAuthenticationParameters';
import { SelectServer } from './utils';
import { ResponseError } from 'vscode-languageclient';

let localize = nls.loadMessageBundle();
const compile = require('template-literal');

const localizeHTML = {
	"tds.webview.newServer.title": localize("tds.webview.newServer.title", "New Server"),
	"tds.webview.newServer.name": localize("tds.webview.newServer.name", "Server Name"),
	"tds.webview.newServer.address": localize("tds.webview.newServer.address", "Address"),
	"tds.webview.newServer.port": localize("tds.webview.newServer.port", "Port"),
	"tds.webview.newServer.save": localize("tds.webview.newServer.save", "Save"),
	"tds.webview.newServer.saveClose": localize("tds.webview.newServer.saveClose", "Save/Close"),
	"tds.webview.newServer.secure": localize("tds.webview.newServer.secure", "Secure(SSL)"),
	"tds.webview.dir.include": localize("tds.webview.dir.include", "Includes directory"),
	"tds.webview.dir.include2": localize("tds.webview.dir.include2", "Allow multiple directories")
};

export const connTypeIds = [ 'CONNT_DEBUGGER', 'CONNT_MONITOR' ] as const;
export type connTypeId = typeof connTypeIds[number];
export const connType: Record<connTypeId, number> = {
	CONNT_DEBUGGER: 3,
	CONNT_MONITOR: 13
} as const;

export let connectedServerItem: ServerItem | undefined;

export class ServerItemProvider implements vscode.TreeDataProvider<ServerItem | EnvSection> {

	private _onDidChangeTreeData: vscode.EventEmitter<ServerItem | EnvSection | undefined> = new vscode.EventEmitter<ServerItem | undefined>();
	readonly onDidChangeTreeData: vscode.Event<ServerItem | EnvSection | undefined> = this._onDidChangeTreeData.event;

	public localServerItems: Array<ServerItem>;

	constructor() {
		// check if there is an open folder
		if (vscode.workspace.workspaceFolders === undefined) {
			vscode.window.showErrorMessage("No folder opened.");
			return;
		}
		this.addServersConfigListener();
		this.addLaunchJsonListener();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ServerItem | EnvSection): vscode.TreeItem {
		if (element instanceof ServerItem) {
			let iconPath = {
				light: path.join(__filename, '..', '..', 'resources', 'light', connectedServerItem !== undefined && element.id === connectedServerItem.id ? 'server.connected.svg' : 'server.svg'),
				dark: path.join(__filename, '..', '..', 'resources', 'dark', connectedServerItem !== undefined && element.id === connectedServerItem.id ? 'server.connected.svg' : 'server.svg')
			};
			element.iconPath = iconPath;
		}
		return element;
	}

	getChildren(element?: ServerItem): Thenable<ServerItem[] | EnvSection[]> {
		if (element) {
			if (element.environments) {
				return Promise.resolve(element.environments);
			}
			else {

				const servers = Utils.getServersConfig();
				const listOfEnvironments = servers.configurations[element.id].environments;
				if (listOfEnvironments.size > 0) {
					treeDataProvider.localServerItems[element.id].environments = listOfEnvironments.map(env => new EnvSection(env, element, vscode.TreeItemCollapsibleState.None, {
						command: 'totvs-developer-studio.environmentSelection',
						title: '',
						arguments: [env]
					}));
					treeDataProvider.localServerItems[element.id].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
					//Workaround: Bug que nao muda visualmente o collapsibleState se o label permanecer intalterado
					treeDataProvider.localServerItems[element.id].label = treeDataProvider.localServerItems[element.id].label.endsWith(' ') ? treeDataProvider.localServerItems[element.id].label.trim() : treeDataProvider.localServerItems[element.id].label + ' ';
					treeDataProvider.refresh();
					element.environments = listOfEnvironments;
					Promise.resolve(new EnvSection(element.name, element, element.collapsibleState, undefined, listOfEnvironments));
				}
				else {
					return Promise.resolve([]);
				}
			}
		} else {
			if (!this.localServerItems) {
				const serverConfig = Utils.getServersConfig();
				if (serverConfig.configurations.length <= 0) { //se o servers.json existe
					this.localServerItems = this.setConfigWithSmartClient();
				} else {
					this.localServerItems = this.setConfigWithServerConfig();
				}

			}
		}

		return Promise.resolve(this.localServerItems.sort((srv1, srv2) => {
			const label1 = srv1.name.toLowerCase();
			const label2 = srv2.name.toLowerCase();
			if (label1 > label2) { return 1; }
			if (label1 < label2) { return -1; }
			return 0;
		}));
	}

	private addServersConfigListener(): void {
		Utils.createServerConfig();
		let serversJson = Utils.getServerConfigFile();
		//Caso o arquivo servers.json seja encontrado, registra o listener já na inicialização.
		fs.watch(serversJson, { encoding: 'buffer' }, (eventType, filename) => {
			if (filename && eventType === 'change') {
				this.localServerItems = this.setConfigWithServerConfig();
				this.refresh();
			}
		});
	}

	private addLaunchJsonListener(): void {
		let launchJson = undefined;
		try {
			launchJson = Utils.getLaunchConfigFile();
		} catch(e) {
			Utils.logInvalidLaunchJsonFile(e);
		}

		if(launchJson) {
			if (!fs.existsSync(launchJson)) {
				Utils.createLaunchConfig();
			}

			if (fs.existsSync(launchJson)) { //Caso o arquivo launch.json seja encontrado, registra o listener já na inicialização.
				fs.watch(launchJson, { encoding: 'buffer' }, (eventType, filename) => {
					const serverConfig = Utils.getServersConfig();
					if (filename && eventType === 'change') {
						if (serverConfig.configurations.length > 0) {
							this.localServerItems = this.setConfigWithServerConfig();
						} else {
							this.localServerItems = this.setConfigWithSmartClient();
						}
						this.refresh();
					}
				});
			}
		}
	}

	/**
	 * Cria os itens da arvore de servidores a partir da leitura do arquivo servers.json
	 */
	private setConfigWithServerConfig() {
		const serverConfig = Utils.getServersConfig();
		const serverItem = (serverItem: string, type: string, address: string, port: number, secure: number, id: string, buildVersion: string, environments: Array<EnvSection>, includes: string[]): ServerItem => {
			return new ServerItem(serverItem, type, address, port, secure, vscode.TreeItemCollapsibleState.None , id, buildVersion, environments , includes, {
				command: '',
				title: '',
				arguments: [serverItem]
			});
		};
		const listServer = new Array<ServerItem>();

		serverConfig.configurations.forEach(element => {
			let environmentsServer = new Array<EnvSection>();
			if (element.environments) {
				element.environments.forEach(environment => {
					const env = new EnvSection(environment, element, vscode.TreeItemCollapsibleState.None,
						{ command: 'totvs-developer-studio.environmentSelection', title: '', arguments: [environment] }, environment);
					environmentsServer.push(env);
				});
			}

			listServer.push(serverItem(element.name, element.type, element.address, element.port, element.secure, element.id, element.buildVersion, environmentsServer, element.includes));
			listServer[listServer.length-1].collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		});

		return listServer;
	}

	/**
	 * Inicia a arvore de servidores lendo o conteudo do smartclient.ini e
	 * cria o arquivo servers.json
	 */
	private setConfigWithSmartClient() {
		let config = undefined;
		try {
			config = Utils.getLaunchConfig();
		} catch(e) {
			Utils.logInvalidLaunchJsonFile(e);
		}
		const configs = config.configurations;

		if (!configs) {
			return new Array<ServerItem>();
		}

		let scBinConf;
		configs.forEach(element => {
			if (element.type === 'totvs_language_debug') {
				scBinConf = element.smartclientBin;
			}
		});

		if (scBinConf) {
			const scIniPath = path.join(
				path.dirname(scBinConf),
				path.win32.basename(scBinConf, path.extname(scBinConf)) + '.ini'
			);
			if (this.pathExists(scIniPath)) {
				const serverItems = this.getTCPSecsInIniFile(scIniPath);
				this.saveServers(serverItems);
				return serverItems;
			} else {
				vscode.window.showInformationMessage(localize("tds.webview.serversView.invalidJson", 'launch.json has an invalid smartclientBin configuration.'));
				return new Array<ServerItem>();
			}
		} else {
			vscode.window.showInformationMessage(localize("tds.webview.serversView.addAttrib", 'Add an attribute smartclientBin with a valid SmartClient path and the executable file name on launch.json.'));
			return new Array<ServerItem>();
		}
	}

	private saveServers(serverItems: ServerItem[]) {

		serverItems.forEach(element => {
			/*const id = */Utils.createNewServer("totvs_server_protheus", element.label, element.port, element.address, element.buildVersion, element.secure, element.includes);

			//A principio parece ser um exagero tentar validar TODOS os servidores ao salvar.
			//Caso essa informação venha do ini do smartclient por exemplo, pode ter um numero muito
			//grande de servidores cadastrados e esse processo fica bastante lento, pois caso o usuario peça
			//para conectar um servidor, o LS tera que processar todas essas requisições que ja estarao na fila
			//das mensagens para enfim processar a mensagem de conexão.

			// languageClient.sendRequest('$totvsserver/validation', {
			// 	validationInfo: {
			// 		server: element.address,
			// 		port: element.port
			// 	}
			// }).then((validInfoNode: NodeInfo) => {
			// 	if (id) {
			// 		Utils.updateBuildVersion(id, validInfoNode.buildVersion);
			// 	}
			// 	return;
			// });

		});
	}

	/**
	 * Given the path to smartclient.ini, read all its TCP Sections.
	 */
	private getTCPSecsInIniFile(scIniPath: string): ServerItem[] {
		if (this.pathExists(scIniPath)) {

			const toTCPSec = (serverItem: string, type: string, address: string, port: number, secure: number, id: string, buildVersion: string): ServerItem => {
				return new ServerItem(serverItem, type, address, port, secure, vscode.TreeItemCollapsibleState.None, id, buildVersion, undefined, undefined, {
					command: '',
					title: '',
					arguments: [serverItem]
				});
			};

			const scIniFileFs = fs.readFileSync(scIniPath, 'utf-8');

			let re = /^\[[^\]\r\n]+](?:\r?\n(?:[^[\r\n].*)?)*/igm;
			let matches = re.exec(scIniFileFs);

			const tcpSecs = new Array<ServerItem>();

			while ((matches = re.exec(scIniFileFs)) !== null) {
				let match = matches[0];
				let address = /^SERVER\s?=(?:\s+)?(.+)/im.exec(match);
				let port = /^PORT\s?=(?:\s+)?(.+)/im.exec(match);
				let secure = /^SECURECONNECTION\s?=(?:\s+)?(.+)/im.exec(match);
				let secureInt = 0;

				if (secure!==null) {
					secureInt = parseInt(secure[1]);
				}

				if ((address !== null) && (port !== null)) {
					let key = /^\[(.+)\]/igm.exec(match);

					if (key !== null) {
						tcpSecs.push(toTCPSec(key[1], "totvs_server_protheus", address[1], parseInt(port[1]), secureInt, Utils.generateRandomID(), ""));
					}
				}
			}
			this.localServerItems = tcpSecs;
			return tcpSecs;
		} else {
			return [];
		}
	}

	private pathExists(p: string): boolean {
		try {
			fs.accessSync(p);
		} catch (err) {
			return false;
		}

		return true;
	}

}

export class ServerItem extends vscode.TreeItem {

	public isConnected: boolean = false;
	public token: string;
	public currentEnvironment: string;

	constructor(
		public name: string,
		public readonly type: string,
		public readonly address: string,
		public readonly port: number,
		public secure: number,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public id: string,
		public buildVersion: string,
		public environments?: Array<EnvSection>,
		public includes?: string[],
		public readonly command?: vscode.Command
	) {
		super(name, collapsibleState);
	}

	public getTooltip(): string {
		return `Server=${this.address} | Port=${this.port}`;
	}

	description = `${this.address}:${this.port}`;

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', connectedServerItem !== undefined && this.id === connectedServerItem.id ? 'server.connected.svg' : 'server.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', connectedServerItem !== undefined && this.id === connectedServerItem.id ? 'server.connected.svg' : 'server.svg')
	};

	contextValue = 'serverItem';
}

export class EnvSection extends vscode.TreeItem {

	constructor(
		public label: string,
		public readonly serverItemParent: ServerItem,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly command?: vscode.Command,
		public environments?: string[]
	) {
		super(label, collapsibleState);
	}

	public getTooltip(): string {
		return `${this.label} @ ${this.serverItemParent.name}`;
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', connectedServerItem !== undefined && connectedServerItem.id === this.serverItemParent.id && connectedServerItem.currentEnvironment === this.label ? 'environment.connected.svg' : 'environment.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', connectedServerItem !== undefined && connectedServerItem.id === this.serverItemParent.id && connectedServerItem.currentEnvironment === this.label ? 'environment.connected.svg' : 'environment.svg')
	};

	contextValue = 'envSection';
}

const treeDataProvider = new ServerItemProvider();
export class ServersExplorer {

	constructor(context: vscode.ExtensionContext) {
		let currentPanel: vscode.WebviewPanel | undefined = undefined;

		vscode.commands.registerCommand('totvs-developer-studio.add', () => {
			if (vscode.workspace.workspaceFolders === undefined) {
				vscode.window.showErrorMessage("No folder opened.");
				return;
			}

			if (currentPanel) {
				currentPanel.reveal();
			} else {
				currentPanel = vscode.window.createWebviewPanel(
					'totvs-developer-studio.add',
					'Novo Servidor',
					vscode.ViewColumn.One,
					{
						enableScripts: true,
						localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'src', 'server'))],
						retainContextWhenHidden: true
					}
				);

				currentPanel.webview.html = getWebViewContent(context, localizeHTML);
				currentPanel.onDidDispose(
					() => {
						currentPanel = undefined;
					},
					null,
					context.subscriptions
				);

				currentPanel.webview.onDidReceiveMessage(message => {
					switch (message.command) {
						case 'checkDir':
							let checkedDir = Utils.checkDir(message.selectedDir);
							currentPanel.webview.postMessage({
								command: "checkedDir",
								checkedDir: checkedDir
							});
							break;
						case 'saveServer':
							const typeServer = "totvs_server_protheus";
							if (message.serverName && message.port && message.address) {
								const serverId = createServer(typeServer, message.serverName, message.port, message.address, 0, "", true, message.includes);
								if (serverId !== undefined) {
									languageClient.sendRequest('$totvsserver/validation', {
										validationInfo: {
											server: message.address,
											port: parseInt(message.port)
										}
									}).then((validInfoNode: NodeInfo) => {
										Utils.updateBuildVersion(serverId, validInfoNode.buildVersion, validInfoNode.secure);
										return;
									}, (err: ResponseError<object>) => {
										vscode.window.showErrorMessage(err.message);
									});
								}
							} else {
								vscode.window.showErrorMessage(localize("tds.webview.serversView.addServerFail", "Add Server Fail. Name, port and Address are need"));
							}

							if (currentPanel) {
								if (message.close) {
									currentPanel.dispose();
								}
							}
					}
				},
					undefined,
					context.subscriptions
				);
			}
		});

		vscode.commands.registerCommand('totvs-developer-studio.config', () => {
			if (vscode.workspace.workspaceFolders === undefined) {
				vscode.window.showErrorMessage("No folder opened.");
				return;
			}
			const servers = Utils.getServerConfigFile();
			if (servers) {
				vscode.window.showTextDocument(vscode.Uri.file(servers));
			}
		});

		// check if there is an open folder
		if (vscode.workspace.workspaceFolders === undefined) {
			vscode.window.showErrorMessage("No folder opened.");
			return;
		}

		const options: vscode.TreeViewOptions<ServerItem | EnvSection> = { treeDataProvider: serverProvider };
		vscode.window.createTreeView('totvs_server', options);
		vscode.window.registerTreeDataProvider('totvs_server', serverProvider);

		vscode.commands.registerCommand('totvs-developer-studio.connect', (serverItem: ServerItem) => {
			let ix = serverProvider.localServerItems.indexOf(serverItem);
			if (ix >= 0) {
				//Verifica se ha um buildVersion cadastrado.
				if (serverItem.buildVersion) {
					inputConnectionParameters(context, serverItem, ConnTypeIds.CONNT_DEBUGGER, false);
				} else {
					//Há build no servidor.
					vscode.window.setStatusBarMessage(`Validando servidor [${serverItem.name}]`,
						sendValidationRequest(serverItem.address, serverItem.port)
							.then((validationInfo: IValidationInfo) => {
								//retornou uma versao valida no servidor.
								const updated = Utils.updateBuildVersion(serverItem.id, validationInfo.build, validationInfo.secure);
								serverItem.buildVersion = validationInfo.build;
								if (updated) {
									//continua a autenticacao.
									inputConnectionParameters(context, serverItem, ConnTypeIds.CONNT_DEBUGGER, false);
								} else {
									vscode.window.showErrorMessage(localize("tds.webview.serversView.couldNotConn", "Could not connect to server"));
								}
								return;
							}, (err: ResponseError<object>) => {
								vscode.window.showErrorMessage(err.message);
							})
					);
				}
			}
		});

		vscode.commands.registerCommand('totvs-developer-studio.reconnect', (serverItem: ServerItem) => {
			let ix = serverProvider.localServerItems.indexOf(serverItem);
			if (ix >= 0) {
				//Verifica se ha um buildVersion cadastrado.
				if (serverItem.buildVersion) {
					inputConnectionParameters(context, serverItem, ConnTypeIds.CONNT_DEBUGGER, true);
				} else {
					vscode.window.showErrorMessage(localize("tds.webview.serversView.couldNotReconn", "Could not reconnect to server"));
				}
			}
		});
		vscode.commands.registerCommand('totvs-developer-studio.disconnect', (serverItem: ServerItem) => {
			if (serverItem.isConnected) {
				vscode.window.setStatusBarMessage(`Desconectando do servidor [${serverItem.name}]`,
					sendDisconnectRequest(serverItem)
						.then((ti: ITokenInfo) => {
							if (!ti.sucess) {
								serverProvider.connectedServerItem = undefined;
								Utils.clearConnectedServerConfig();
							}
						}, (err: ResponseError<object>) => {
							Utils.clearConnectedServerConfig();
							handleError(err);
						})
				);
			} else {
				vscode.window.showInformationMessage(localize("tds.webview.serversView.alreadyConn", "Server is already disconnected"));
			}
		});

		vscode.commands.registerCommand('totvs-developer-studio.selectenv', (environment: EnvSection) => {
			inputConnectionParameters(context, environment, ConnTypeIds.CONNT_DEBUGGER, false);
		});

		vscode.commands.registerCommand('totvs-developer-studio.delete', (serverItem: ServerItem) => {
			let ix = serverProvider.localServerItems.indexOf(serverItem);
			if (ix >= 0) {
				Utils.deleteServer(serverItem.id);
			}

		});

		vscode.commands.registerCommand('totvs-developer-studio.rename', (serverItem: ServerItem) => {
			let ix = serverProvider.localServerItems.indexOf(serverItem);
			if (ix >= 0) {
				vscode.window.showInputBox({
					placeHolder: localize("tds.webview.serversView.renameServer", "Rename the server"),
					value: serverItem.label
				}).then((newName: string) => {
					Utils.updateServerName(serverItem.id, newName);
				});
			}

		});

		function createServer(typeServer: string, serverName: string, port: number, address: string, secure: number, buildVersion: string, showSucess: boolean, includes: string[]): string | undefined {
			const serverId = Utils.createNewServer(typeServer, serverName, port, address, buildVersion, secure, includes);

			if (serverId !== undefined && showSucess) {
				vscode.window.showInformationMessage(localize("tds.webview.serversView.serverSaved", "Saved server ") + serverName);
			}

			return serverId;
		}

		function getWebViewContent(context, localizeHTML) {

			const htmlOnDiskPath = vscode.Uri.file(path.join(context.extensionPath, 'src', 'server', 'addServer.html'));
			const cssOniskPath = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'css', 'form.css'));

			const htmlContent = fs.readFileSync(htmlOnDiskPath.with({ scheme: 'vscode-resource' }).fsPath);
			const cssContent = fs.readFileSync(cssOniskPath.with({ scheme: 'vscode-resource' }).fsPath);

			let runTemplate = compile(htmlContent);

			return runTemplate({ css: cssContent, localize: localizeHTML });
		}
	}

}

function doFinishConnectProcess(serverItem: ServerItem, token: string, environment: string) {

	Utils.saveConnectionToken(serverItem.id, token, environment);
	Utils.saveSelectServer(serverItem.id, token, serverItem.name, environment, "", "");

	if (serverProvider !== undefined) {
		serverItem.currentEnvironment = environment;
		serverItem.token = token;

		serverProvider.connectedServerItem = serverItem;
	}
}

export function connectServer(serverItem: ServerItem, environment: string, connType: ConnTypeIds) {
	if (!serverItem.isConnected && serverItem.currentEnvironment ===environment) {
		vscode.window.showInformationMessage(localize("tds.webview.serversView.alreadyDisconn", "The server selected is already connected."));
	} else {

		if (serverProvider.connectedServerItem !== undefined) {
			vscode.commands.executeCommand('totvs-developer-studio.disconnect', serverProvider.connectedServerItem);
		}

		vscode.window.setStatusBarMessage(`Conectando-se ao servidor [${serverItem.name}]`,
			sendConnectRequest(serverItem, environment, connType)
				.then((result: any) => {
					if (result) {
						if (result.needAuthentication) {
							inputAuthenticationParameters(serverItem, environment);
						} else {
							doFinishConnectProcess();
						}
					}
				}, (error) => {
					vscode.window.showErrorMessage(error);
				})
		);
	}
}

export function authenticate(serverItem: ServerItem, environment: string, username: string, password: string) {
	vscode.window.setStatusBarMessage(`Autenticando usuário [${username}] no servidor [${serverItem.name}]`,
		sendAuthenticateRequest(serverItem, environment, username, password)
			.then((result: IAuthenticationInfo) => {
				let token: string = result.token;
				return result.sucess ? token: "";
			}, (error: any) => {
				vscode.window.showErrorMessage(error);
				return false;
			}).then((token: string) => {
				if (token) {
					if (treeDataProvider !== undefined) {
						connectedServerItem = serverItem;
						connectedServerItem.currentEnvironment = environment;
						connectedServerItem.token = token;
					}

					Utils.saveSelectServer(serverItem.id, token, serverItem.name, environment, username, password);
					Utils.saveConnectionToken(serverItem.id, token, environment);

					treeDataProvider.refresh();

				}
			})
	);
}


export function reconnectServer(reconnectionInfo: any, environment: string, connType: ConnTypeIds): boolean {
	if (reconnectionInfo.id && reconnectionInfo.token) {
		const servers = Utils.getServersConfig();
		if (servers.configurations) {
			servers.configurations.forEach(element => {
				if (element.id === reconnectionInfo.id) {
					let serverItem: ServerItem = new ServerItem(element.name, element.type, element.address, element.port, element.secure, vscode.TreeItemCollapsibleState.None, element.id,
						element.buildVersion, element.environments, element.includes,
						{
							command: '',
							title: '',
							arguments: [element.name]
						}
					);
					if (connectedServerItem !== undefined) {
						vscode.commands.executeCommand('totvs-developer-studio.disconnect', connectedServerItem);
					}
					vscode.window.setStatusBarMessage(`Reconectando-se ao servidor [${serverItem.name}]`,
						sendReconnectRequest(serverItem, reconnectionInfo.token, connType)
							.then((ri: IReconnectInfo) => {
								return ri.sucess;
							})
					);
				}
			});
		}
	}

	return false;
}

export function reconnectLastServer() {
	const servers = Utils.getServersConfig();
	if (servers.lastConnectedServer.id) {
		if (servers.configurations) {
			servers.configurations.forEach(element => {
				if (element.id === servers.lastConnectedServer.id) {
					let serverItem: ServerItem = new ServerItem(element.name, element.type, element.address, element.port, element.secure, vscode.TreeItemCollapsibleState.None, element.id,
						element.buildVersion, element.environments, element.includes,
						{
							command: '',
							title: '',
							arguments: [element.name]
						}
					);
					const token = servers.lastConnectedServer.token;
					reconnectServer({ serverItem, token }, servers.lastConnectedServer.environment, ConnTypeIds.CONNT_DEBUGGER);
				}
			});
		}
	}
}

class NodeError {
	code: number;
	message: string;
}

function handleError(nodeError: NodeError) {
	vscode.window.showErrorMessage(nodeError.code + ': ' + nodeError.message);
}

export function updateStatusBarItem(selectServer: SelectServer | undefined): void {
	if (selectServer) {
		totvsStatusBarItem.text = `${selectServer.name} / ${selectServer.environment}`;
	} else {
		totvsStatusBarItem.text = localize('tds.vscode.select_server_environment', '[ Selecionar servidor/ambiente ]');
	}

	totvsStatusBarItem.show();
}
