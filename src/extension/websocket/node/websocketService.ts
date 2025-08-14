/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { createDecorator as createServiceIdentifier } from '../../../util/vs/platform/instantiation/common/instantiation';

export interface IWebSocketService {
	readonly _serviceBrand: undefined;
	start(): Promise<void>;
	stop(): Promise<void>;
	isRunning(): boolean;
	getPort(): number;
	broadcast(message: any): void;
}

export const IWebSocketService = createServiceIdentifier<IWebSocketService>('IWebSocketService');

export class WebSocketService implements IWebSocketService {
	readonly _serviceBrand: undefined;
	private server?: Server;
	private wss?: WebSocketServer;
	private port = 3001;
	private isActive = false;
	private connectedClients: Set<WebSocket> = new Set();
	private static instance?: WebSocketService;

	constructor() {
		// No parameters needed for DI
		WebSocketService.instance = this;
	}

	static getInstance(): WebSocketService | undefined {
		return WebSocketService.instance;
	}

	async start(): Promise<void> {
		if (this.isActive) {
			return;
		}

		try {
			this.server = createServer();
			this.wss = new WebSocketServer({ server: this.server });

			this.wss.on('connection', (ws: WebSocket) => {
				console.log('WebSocket client connected');
				this.connectedClients.add(ws);

				ws.on('message', async (message: Buffer) => {
					try {
						const data = JSON.parse(message.toString());

						if (data.type === 'chat' && data.message) {
							// Send initial confirmation
							ws.send(JSON.stringify({
								type: 'chat_started',
								status: 'success',
								message: 'Chat session initiated'
							}));

							// Execute the VS Code command to open chat with the message
							const vscodeModule = await import('vscode');
							await vscodeModule.commands.executeCommand('workbench.action.chat.open', {
								query: data.message
							});

							// Send final confirmation
							ws.send(JSON.stringify({
								type: 'chat_opened',
								status: 'success',
								message: 'Chat opened successfully'
							}));
						} else if (data.type === 'clear_history') {
							// Send initial confirmation
							ws.send(JSON.stringify({
								type: 'clear_started',
								status: 'success',
								message: 'Clearing chat history...'
							}));

							// Execute the VS Code command to clear chat history
							const vscodeModule = await import('vscode');
							await vscodeModule.commands.executeCommand('workbench.action.chat.clearHistory');

							// Send final confirmation
							ws.send(JSON.stringify({
								type: 'clear_completed',
								status: 'success',
								message: 'Chat history cleared successfully'
							}));
						} else {
							ws.send(JSON.stringify({
								type: 'error',
								status: 'error',
								message: 'Invalid message format. Expected: {type: "chat", message: "your message"} or {type: "clear_history"}'
							}));
						}
					} catch (error) {
						console.error('Error processing WebSocket message:', error);
						ws.send(JSON.stringify({
							type: 'error',
							status: 'error',
							message: 'Failed to process message'
						}));
					}
				});

				ws.on('close', () => {
					console.log('WebSocket client disconnected');
					this.connectedClients.delete(ws);
				});

				ws.on('error', (error) => {
					console.error('WebSocket error:', error);
					this.connectedClients.delete(ws);
				});
			});


			return new Promise((resolve, reject) => {
				this.server!.listen(this.port, () => {
					this.isActive = true;
					console.log(`WebSocket server started on port ${this.port}`);
					resolve();
				});

				this.server!.on('error', (error) => {
					reject(error);
				});
			});
		} catch (error) {
			console.error('Failed to start WebSocket server:', error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.isActive) {
			return;
		}


		return new Promise((resolve) => {
			if (this.wss) {
				this.wss.close(() => {
					if (this.server) {
						this.server.close(() => {
							this.isActive = false;
							this.connectedClients.clear();
							console.log('WebSocket server stopped');
							resolve();
						});
					} else {
						this.isActive = false;
						this.connectedClients.clear();
						resolve();
					}
				});
			} else {
				this.isActive = false;
				this.connectedClients.clear();
				resolve();
			}
		});
	}

	isRunning(): boolean {
		return this.isActive;
	}

	getPort(): number {
		return this.port;
	}

	broadcast(message: any): void {
		const messageString = JSON.stringify(message);
		this.connectedClients.forEach(client => {
			if (client.readyState === WebSocket.OPEN) {
				try {
					client.send(messageString);
				} catch (error) {
					console.error('Error sending message to client:', error);
					this.connectedClients.delete(client);
				}
			}
		});
	}

}