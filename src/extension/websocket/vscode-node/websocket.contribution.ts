/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { WebSocketService } from '../node/websocketService';

export class WebSocketContribution implements IExtensionContribution {
	private _disposables = new DisposableStore();

	constructor() {
		// Start the WebSocket server immediately when the contribution is created
		this.startWebSocketServer();
	}

	private async startWebSocketServer(): Promise<void> {
		try {
			// Create the service directly to avoid DI issues
			const websocketService = new WebSocketService();

			// Start the WebSocket server
			await websocketService.start();
			console.log(`Copilot Chat WebSocket server started on port ${websocketService.getPort()}`);

			// Register disposal
			this._disposables.add({
				dispose: () => {
					websocketService.stop();
				}
			});
		} catch (error) {
			console.error('Failed to start WebSocket server:', error);
		}
	}

	dispose(): void {
		this._disposables.dispose();
	}
}