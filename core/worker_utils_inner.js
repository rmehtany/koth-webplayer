define(['require', './EventObject'], (require, EventObject) => {
	'use strict';

	const awaiting = new Map();

	function handleScript(event) {
		const src = event.data.require_script_src;
		const done = awaiting.get(src);
		if(!done) {
			return;
		}
		importScripts(URL.createObjectURL(new Blob(
			[event.data.require_script_blob],
			{type: 'text/javascript'}
		)));
		awaiting.delete(src);
		done();
	}

	require.replaceLoader((src, done) => {
		awaiting.set(src, done);
		self.postMessage({require_script_src: src});
	});

	const originalShed = require.shed;
	require.shed = () => {
		self.postMessage({require_script_src: null});
		originalShed();
	};

	// We must manage the "message" events ourselves so that we can intercept
	// require() results. Simply adding a "message" listener wouldn't be enough
	// to avoid potential race conditions (messages will queue while there are
	// NO listeners, but not once there's ONE)

	const queueIn = [];

	const listeners = new EventObject();

	self.addEventListener('message', (event) => {
		if(event.data && event.data.require_script_blob) {
			return handleScript(event);
		}
		if(listeners.countEventListeners('message') > 0) {
			listeners.trigger('message', [event]);
		} else {
			queueIn.push(event);
		}
	});

	const rawAddEventListener = self.addEventListener;
	self.addEventListener = (type, fn, opts) => {
		if(type === 'message') {
			listeners.addEventListener(type, fn);
			if(queueIn.length > 0) {
				queueIn.forEach((message) => listeners.trigger('message', [message]));
				queueIn.length = 0;
			}
		} else {
			rawAddEventListener(type, fn, opts);
		}
	};

	const rawRemoveEventListener = self.removeEventListener;
	self.removeEventListener = (type, fn, opts) => {
		listeners.removeEventListener(type, fn);
		rawRemoveEventListener(type, fn, opts);
	};
});
