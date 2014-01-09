var dgram = require('dgram');
var net = require('net');
var util = require('util');
var events = require('events');
var clone = require('clone');

var packet = require('./packet');

var port = 56700;

var debug = false;

// This represents each individual bulb
function Bulb(_lifxAddress, _name, _state) {
	this.lifxAddress = _lifxAddress;
	this.name        = _name;
	this.updateState(_state);
}

Bulb.prototype.updateState = function (s) {
	this.state			 = s;
	delete this.state.bulbLabel;
};

// This represents the gateway, and its respective functions (eg discovery, send-to-all etc)
function Gateway(ipAddress, port, site) {
	// TODO: validation...
	this.ipAddress = {ip:ipAddress, port:port};
	this.lifxAddress = site;
	this.tcpClient = null;
	this.reconnect = true;
	events.EventEmitter.call(this);
}

// Make the Gateway into an event emitter
Gateway.prototype.__proto__ = events.EventEmitter.prototype;

function init() {
	var l = new Lifx();
	l.startDiscovery();
	return l;
}

function Lifx() {
	events.EventEmitter.call(this);
	this.gateways = [];
	this.bulbs = {};  // store each bulb by name
	this.groups = {}; // each tag contains an array of bulbs
	this.groupLabels = {};
	this._intervalID = null;
}
Lifx.prototype.__proto__ = events.EventEmitter.prototype;

Lifx.prototype.startDiscovery = function() {
	var self = this;
	var UDPClient = dgram.createSocket("udp4");
	UDPClient.unref(); // Stop this from preventing Node from ending

	UDPClient.on("error", function (err) {
		console.log("UDP error " + err);
	});

	UDPClient.on("message", function (msg, rinfo) {
		if (debug) console.log(" U- " + msg.toString("hex"));
		var pkt = packet.fromBytes(msg);
		if (pkt.packetTypeShortName == 'panGateway' && pkt.payload.service == 1) {
			var gw = new Gateway(rinfo.address, pkt.payload.port, pkt.preamble.site);
			self.foundGateway(gw);
		}
	});

	UDPClient.bind(port, "0.0.0.0", function() {
		UDPClient.setBroadcast(true);
		var intervalID;
		// Now send the discovery packets
		self._intervalID = setInterval(function() {

			var message = packet.getPanGateway({protocol:21504});

			if (debug) console.log(" U+ " + message.toString("hex"));
			UDPClient.send(message, 0, message.length, port, "255.255.255.255", function(err, bytes) {
			});
		}, 1000);
	});

};

Lifx.prototype.foundGateway = function(gw) {
	var found = false;
	for (var i in this.gateways) {
		if (this.gateways[i].ipAddress.ip.toString('hex') == gw.ipAddress.ip.toString('hex')) {
			found = true;
		}
	}
	if (!found) {
		this.gateways.push(gw);
		// Look for bulbs on this gateway
		gw.connect();
		gw.on('_packet', this._getPacketHandler());
		gw.findBulbs();
		// tag discovery code. NOTE: not tested on multiple gateways.
		this.on("tag", function(tag) {
			gw.send(packet.getTagLabels({tags:tag}));		
		});
		
		this.emit("gateway", gw);
	}
};

Lifx.prototype._getPacketHandler = function() {
	var self = this;
	return function(p, gw) {self._gotPacket(p, gw);};
};

Lifx.prototype._gotPacket = function(data, gw) {
	if (debug) console.log(" T- " + data.toString("hex"));

	var p = packet.fromBytes(data);
//	console.log(" T- " + p.packetTypeShortName + ": " + data.toString("utf8"));

	switch (p.packetTypeShortName) {
		case 'lightStatus':
			this.foundBulb(p, gw);
			break;
		case 'tags':
			console.log("Tags: " + p.payload.tags);
			break;
		case 'tagLabels':
			this.groupLabels[p.payload.label.toString().toLowerCase()] = p.payload['tags'];
			break;
	}

	this.emit('packet', clone(p));
};

Lifx.prototype._gotPacket_old = function(data, gw) {
	if (debug) console.log(" T- " + data.toString("hex"));
	switch (data[32]) {

		case 0x6b:
			this.foundBulb(data, gw);
			break;

		case 0x16:
			var bulb = this.getBulbByLifxAddress(data.slice(8,14));
			if (data[37] == 0xff) {
				this.emit('bulbonoff', {bulb:clone(bulb),on:true});
				if (debug) console.log(" * Light is on");
			} else {
				this.emit('bulbonoff', {bulb:clone(bulb),on:false});
				if (debug) console.log(" * Light is off");
			}
			break;
	}
};

Lifx.prototype.foundBulb = function(bulb, gw) {

	var bulbName = bulb.payload.bulbLabel.toLowerCase();
	var lifxAddress = bulb.preamble.bulbAddress;
	if (debug) console.log(" * Found a bulb: " + bulbName + " (address " + util.inspect(lifxAddress) + ")");

	var foundBulb = null;
	if (this.bulbs[bulbName] && this.bulbs[bulbName].lifxAddress.toString("hex") == lifxAddress.toString("hex")) {
		foundBulb = this.bulbs[bulbName];
		foundBulb.updateState(bulb.payload);
	} else {
		var newBulb = new Bulb(lifxAddress, bulbName, bulb.payload);
		if (debug) console.log("*** New bulb found (" + newBulb.name + ") by gateway " + gw.ipAddress.ip + " ***");
		this.bulbs[bulbName] = newBulb;
		
		// associate bulb with group if tag is present
		if (bulb.payload['tags']) {
				var tag = bulb.payload['tags'];
				if (this.groups[tag]) {
					this.groups[tag].push(newBulb)
				} else {
					if (debug) console.log("*** New tag found (" + JSON.stringify(tag) + ") ***");
					this.groups[tag] = [newBulb];
					this.emit('tag', clone(tag));
				}
		}
		
		this.emit('bulb', clone(newBulb));
		foundBulb = newBulb;
	}

	this.emit('bulbstate', {bulb:foundBulb, state:bulb.payload});
};

Lifx.prototype.getBulbByLifxAddress = function(lifxAddress) {
	var addrToSearch = lifxAddress;
	if (typeof lifxAddress != 'string') {
		addrToSearch = lifxAddress.toString('hex');
	}
	for (var i in this.bulbs) {
		if (this.bulbs[i].lifxAddress.toString('hex') == addrToSearch) {
			return this.bulbs[i];
		}
	}
	return false;
};

// Open a control connection (over TCP) to the gateway node
Gateway.prototype.connect = function() {
	var self = this;
	if (debug) console.log("Connecting to " + this.ipAddress.ip + ":" + this.ipAddress.port);
	this.tcpClient = net.connect(this.ipAddress.port, this.ipAddress.ip);
	this.tcpClient.on('data', function(data) {
		self.emit('_packet', data, self);
	});
	this.tcpClient.on('error', function(err) {
		console.log("TCP client Error: " + err);
	});
	this.tcpClient.on('close', function() {
		if (debug) console.log('TCP client disconnected');
		self.tcpClient.destroy();
		if (self.reconnect) {
			self.connect();
		}
	});
};

Lifx.prototype.getBulbsInGroup = function(label) {
	return this.groups[this.groupLabels[label]];
};

Lifx.prototype.listGroups = function() {
	return Object.keys(this.groupLabels);
};

// will only return the bulbs it currently knows about.
Lifx.prototype.listBulbs = function(label, status) {
	if (label) {
		var b = [];
		this.getBulbsInGroup(label).forEach(function(n) {b.push(status ? n : n.name);})
		return b;
	} else {
		return status ? this.bulbs : Object.keys(this.bulbs);
	}
};

// will get a fresh data from the wire.
Lifx.prototype.pollBulbs = function(label) {
	if (label) {
		var b = [];
		this.getBulbsInGroup(label).forEach(function(n) {b.push(n.name);})
		return b;
	} else {
		this.findBulbs();
	}
};

Lifx.prototype.findBulbs = function() {
	this.gateways.forEach(function(g) {
		g.findBulbs();
	});
};

// This method requests that the gateway tells about all of its bulbs
Gateway.prototype.findBulbs = function() {
	this.send(packet.getLightState());
};

// Send a raw command
Gateway.prototype.send = function(sendBuf) {
	if (debug) console.log(" T+ " + sendBuf.toString("hex"));
	var siteAddress = this.lifxAddress;
	siteAddress.copy(sendBuf, 16);
	this.tcpClient.write(sendBuf);
};

// Close the connection to this gateway
Gateway.prototype.close = function() {
	this.reconnect = false;
	this.tcpClient.end();
};

Lifx.prototype.close = function() {
	clearInterval(this._intervalID);
	this.gateways.forEach(function(g) {
		g.close();
	});
};

Lifx.prototype.sendToAll = function(command) {
	this._sendToOneOrAll(command);
};

Lifx.prototype.sendToOne = function(command, bulb) {
	this._sendToOneOrAll(command, bulb);
};

Lifx.prototype._sendToOneOrAll = function(command, bulb) {
	this.gateways.forEach(function(g) {
		var siteAddress = g.lifxAddress;
		siteAddress.copy(command, 16);
		if (typeof bulb == 'undefined') {
			g.send(command);
		} else if (bulb instanceof Array) {
			for (i in bulb) {
				// Overwrite the bulb address here
				var target;
				if (Buffer.isBuffer(bulb[i])) {
					target = bulb[i];
				} else if (typeof bulb[i].lifxAddress != 'undefined') {
					target = bulb[i].lifxAddress;
				} else {
					throw "Unknown bulb";
				}
				target.copy(command, 8);
				g.send(command);
			}
		} else {
			// Overwrite the bulb address here
			var target;
			if (Buffer.isBuffer(bulb)) {
				target = bulb;
			} else if (typeof bulb.lifxAddress != 'undefined') {
				target = bulb.lifxAddress;
			} else {
				throw "Unknown bulb";
			}
			target.copy(command, 8);
			g.send(command);
		}
	});
};

// Set bulbs to a particular colour
// Pass in 16-bit numbers for each param - they will be byte shuffled as appropriate
Lifx.prototype.setLightColour = function(bulbs, hue, sat, bright, kelvin, timing) {
	var params = {stream:0, hue:hue, saturation:sat, brightness:bright, kelvin:kelvin, fadeTime:timing};
	this._sendToOneOrAll(packet.setLightColour(params), bulbs);
};

/////// Fun methods ////////

// Turn all lights on
Lifx.prototype.lightsOn = function(bulb) {
	this._sendToOneOrAll(packet.setPowerState({onoff:1}), bulb);
};

// Turn all lights off
Lifx.prototype.lightsOff = function(bulb) {
	this._sendToOneOrAll(packet.setPowerState({onoff:0}), bulb);
};

// Request status from bulbs
Lifx.prototype.requestStatus = function() {
	this._sendToOneOrAll(packet.getLightState());
};

module.exports = {
	init:init,
	setDebug:function(d){debug=d;}
};

