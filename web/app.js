var util = require('util');
var express = require('express');
var q = require('q');

var app = express();
app.use('/', express.static(__dirname + '/static'));
app.use(express.bodyParser());

app.get('/set/bulb1', function(req, res, next) {
	var bulb1 = req.query.bulb1;
	// scale it
	var hue = Math.floor(bulb1.h * (65536 / 360));
	var sat = Math.floor(bulb1.s * (65536 / 0.8));
	sat = (sat > 32767 ? 32767 : sat);
	var lum = Math.floor(bulb1.l * (65536 / 1));
	console.log(hue, sat, lum);
	lx.lightsColour(hue, sat, lum, 0x0dac, 0);
	res.end("OK");
});

// POST /bulbs/LABEL/toggle 
// with JSON data: {"onff":"on OR off"}
app.post('/bulbs/:label/toggle', function(req, res, next){
	var label = req.params.label.toLowerCase();
	var onoff = req.body.onoff.toLowerCase();
	console.log("set " + label + " to " + onoff);
	try {
	if (label === "all") {
		toggleBulbs(undefined, onoff);
	} else {
		var bulbs = lx.getBulbsInGroup(label);
		if (bulbs) {
			toggleBulbs(bulbs, onoff);
		} else {
			toggleBulbs(lx.bulbs[label], onoff);
		}
	}
	res.end("OK");
	} catch (error) {
		console.log("toggleBulbs: " + error);
		res.send(500, error.message);
	}
});

function toggleBulbs(bulbs, onoff) {
	if (onoff === "on") {
		lx.lightsOn(bulbs);
	} else if (onoff === "off") {
		lx.lightsOff(bulbs);
	} else {
		throw new Error("Unknown value " + onoff);
	}
}

// POST /bulbs/LABEL/color 
// with JSON data {"hue": H, "saturation": S, "brightness": B, "kelvin": K}
// H + S for color, B + K for white light.
// TODO: Perhaps separate colors and whites?
app.post('/bulbs/:label/color', function(req, res, next){
	// TODO: check for legal params.
	// brightness 655 - 65535
	// sat 0 - 655535
	// hue 0? - 65535?
	// kelvin 0-8000
	// dim - TODO: add an action for dim.
	var label = req.params.label.toLowerCase();
	var bright = req.body.brightness;
	var sat = req.body.saturation;
	var hue = req.body.hue;
	var kelvin = req.body.kelvin;
	
	try {
		if (label === "all") {
			lx.setLightColour(undefined, hue, sat, bright, kelvin, 0x0dac);
		} else {
			var bulbs = lx.getBulbsInGroup(label);
			if (bulbs) {
				lx.setLightColour(bulbs, hue, sat, bright, kelvin, 0x0dac);
			} else {
				lx.setLightColour([lx.bulbs[label]], hue, sat, bright, kelvin, 0x0dac);
			}
		}
		res.end("OK");
	} catch (error) {
		console.log("setLightColour: " + error);
		res.send(500, error.message);
	}
});

app.get('/bulbs', function(req, res, next) {
	if (req.param('status') != "1") {
		res.end(JSON.stringify(lx.listBulbs(undefined, false)));
	} else {
		lx.findBulbs();
		var deferred = q.defer();

		setTimeout(function(){
			res.end(JSON.stringify(lx.listBulbs(undefined, true)));
			console.log("wrote response.");
			deferred.resolve();
		}, 5000);
		
	}
});

app.get('/groups', function(req, res, next){
	res.end(JSON.stringify(lx.listGroups()));
});

app.get('/groups/:label', function(req, res, next){
	var label = req.params.label.toLowerCase();
	if (req.param('status') != "1") {
		res.end(JSON.stringify(lx.listBulbs(label, false)));
	} else {
		lx.findBulbs();
		var deferred = q.defer();

		setTimeout(function(){
			res.end(JSON.stringify(lx.listBulbs(label, true)));
			console.log("wrote response.");
			deferred.resolve();
		}, 5000);
		
	}
});

app.get('/set/all/on', function(req, res, next){
	console.log("turn all on");
	lx.lightsOn();
	res.end("OK");
});

app.get('/set/all/off', function(req, res, next){
	console.log("turn all off");
	lx.lightsOff();
	res.end("OK");
});

port = 54751;
app.listen(port);
console.log('Listening on port ' + port);



var lifx = require('../lifx');
var lx = lifx.init();
var bedroom = [];
var office = [];

lx.on('bulb', function(b) {
	console.log('New bulb found: ' + b.name);
});

