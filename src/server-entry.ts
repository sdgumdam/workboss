import {runServer} from './server.js';

runServer().catch(err => {
	console.error('workboss server crashed:', err);
	process.exit(1);
});
