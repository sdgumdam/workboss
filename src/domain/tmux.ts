export interface TmuxClient {
	isAvailable(): Promise<boolean>;
	isInWorkbossSession(): Promise<boolean>;
	sessionExists(): Promise<boolean>;
	createSplitLayout(bossCwd: string): Promise<void>;
	sendKeys(target: string, command: string): Promise<void>;
	killSession(): Promise<void>;
}
