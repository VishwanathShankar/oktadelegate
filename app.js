const express = require("express");
const OktaJwtVerifier = require('@okta/jwt-verifier');
const bodyParser = require('body-parser');
const redis = require("redis");
const request = require('request');
var https = require('https');
var http = require('http');
var fs = require('fs');

var localFilePath="/Users/16399/practice/oktadelegate/";
var serverFilePath="/home/okta/oktadelegate/";

var options = {
  key: fs.readFileSync(serverFilePath + 'client-key.pem'),
  cert: fs.readFileSync(serverFilePath + 'client-cert.pem')
};

/**
 * Environment variables
 */
const base_url = process.env.BASE_URL || 'https://dev-48396690.okta.com'
const issuer = process.env.ISSUER || 'https://dev-48396690.okta.com/oauth2/default'
const client_id = process.env.CLIENT_ID || 'clientid'
const assert_aud = process.env.ASSERT_AUD || 'api://default'
const assert_scope = process.env.ASSERT_SCOPE || 'groupadmin'
const SSWS = process.env.SSWS || '00cp-n2MrpfdwmqruYJyC1awutddUrvkoE78CKAJEF'
const client_username = process.env.CLIENT_USERNAME || 'serviceaccountusername'
const client_password = process.env.CLIENT_PASSWORD || 'password123#'
const time_limit = process.env.TIME_LIMIT || '60'

const redis_client = redis.createClient(6379, process.env.ELASTICACHE_CONNECT_STRING);
redis_client.on("error", function (err) {
    console.log("Error " + err);
});

const app = express();
app.use(bodyParser.json());
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH,OPTIONS');
  next();
});

/*
 * Do a Basic Auth check on the callback
 * This is middleware that asserts valid credentials are passed into the Callback Request
 */
function callbackAuthRequired(req, res, next) {
	const authHeader = req.headers.authorization || '';
	const match = authHeader.match(/Basic (.+)/);

	if (!match) {
		return res.status(401).end();
	}

	const credentials = match[1];
	var auth = Buffer.from(client_username + ':' + client_password).toString('base64');

	if (credentials === auth) {
		next();		
	} else {
		res.status(401).send('Callback Request Not authorized');
	}
}

app.post('/delegate/hook/callback', callbackAuthRequired, (req, res) => {
	/*
	 * sessionid:
	 * Use a value that uniquely identifies the transaction. context.session.id is the best choice 
	 * but is not always present in the callback request (e.g. when refresh_token is used to get fresh access_token; because this is server side operation with no session)
	 * context.session.id is always present when tokens are requested client-side (i.e. using /authorize endpoint)
	 */
	//var sessionid = req.body.data.context.session;
	var sessionid = req.body.data.context.protocol.issuer.uri + '-' + req.body.data.context.user.id + '-' + req.body.data.context.protocol.client.id;

	var default_profile = req.body.data.context.user.profile;

	// redis "get" operation
	function redis_get_promise(key) {
		return new Promise((resolve, reject) => {
			redis_client.get(key, (error, result) => {
				if (error) throw error;
				var value = JSON.parse(result);
				resolve(value);
			})
		})
	}

	// redis "del" operation
	function redis_del_promise(key) {
		return new Promise((resolve, reject) => {
			redis_client.del(key, (error, result) => {
				resolve(result);
			})
		})
	}

	async function callback(key) {
		var profile = await redis_get_promise(key);
		var del = await redis_del_promise(key);
		console.log('del='+del);

		var debug_statement = {};
		if (profile) {
			debug_statement = default_profile.firstName + ' ' + default_profile.lastName + ' is performing actions on-behalf-of ' + profile.firstName + ' ' + profile.lastName;
		} else {
			profile = default_profile;
		}
		var callback_response = {
			"commands": [{
				"type": "com.okta.access.patch",
				"value": [{
					"op": "add",
					"path": "/claims/sessionid",
					"value": sessionid
				},
				{
					"op": "add",
					"path": "/claims/user_context",
					"value": profile
				}]
			}],
			"debugContext": {
				"userDelegationEventLogging": debug_statement
			}
		}
		res.send(callback_response);
	}

	callback(sessionid);
})


const oktaJwtVerifier = new OktaJwtVerifier({
  issuer: issuer,
  clientId: client_id,
  assertClaims: {
    aud: assert_aud,
  },
});

/**
 * A simple middleware that asserts valid access tokens and sends 401 responses
 * if the token is not present or fails validation.  If the token is valid its
 * contents are attached to req.jwt
 */
function authenticationRequired(req, res, next) {
	const authHeader = req.headers.authorization || '';
	const match = authHeader.match(/Bearer (.+)/);

	if (!match) {
		return res.status(401).end();
	}

	const accessToken = match[1];
	return oktaJwtVerifier.verifyAccessToken(accessToken)
	.then((jwt) => {
		req.jwt = jwt;

		var scopes = req.jwt.claims.scp; 
		if (!scopes.includes(assert_scope)) {
			res.status(401).send('Not authorized to delegate');
		}
		var sessionid = req.jwt.claims.sessionid;
		if (!sessionid) {
			res.status(401).send('Invalid session');	
		}

		next();
	})
	.catch((err) => {
		res.status(401).send(err.message);
	});
}

app.get('/testService', function(req, res){
	res.send('Service Working');
  });
  

app.post('/delegate/init', authenticationRequired, (req, res) => {
	var sessionid = req.jwt.claims.sessionid;
	
	// The Bearer token to this api call contains a "uid" claim. This is the Okta userId
	var admin_id = req.jwt.claims.uid;

	var headers = {
		'Authorization': 'SSWS ' + SSWS
	}


	// get the target's group memberships
	function groups_promise(target_id) {
		return new Promise((resolve, reject) => {
			var groups = [];
			var users_groups_api = base_url + '/api/v1/users/' + target_id + '/groups';	
			request({url: users_groups_api, headers: headers}, (error, response, body) => {
				if (!error && response.statusCode == 200) {
					groups = JSON.parse(body);
				}
				resolve(groups);
			});
		}) 
	}

	// need the Actor's "Group Admin" roleId
	function get_roleid_promise(admin_id) {
		return new Promise((resolve, reject) => {
			var role_id = null;
			var admins_roles_api = base_url + '/api/v1/users/' + admin_id + '/roles';
			request({url: admins_roles_api, headers: headers}, (error, response, body) => {
				if (!error && response.statusCode == 200) {
					var info = JSON.parse(body);
					for (var i=0; i<info.length; i++) {
						if (info[i].type === 'USER_ADMIN') {
							role_id = info[i].id;
							break;
						}
					}
				}
				resolve(role_id);
			})
		})
	}

	// get all the groups the Actor manages
	function user_admin_groups_promise(admin_id, role_id) {
		var groups = [];
		return new Promise((resolve, reject) => {
			var admins_roles_targets_groups_api = base_url + '/api/v1/users/' + admin_id + '/roles/' + role_id + '/targets/groups';
			request({url: admins_roles_targets_groups_api, headers: headers}, (error, response, body) => {
				if (!error && response.statusCode == 200) {
					groups = JSON.parse(body);
				}
				resolve(groups);
			})
		})
	}

	// get user
	function user_profile_promise(username) {
		var users = null;
		return new Promise((resolve, reject) => {
			var users_api = base_url + '/api/v1/users?filter=profile.login%20eq%20%22' + username + '%22';
			request({url: users_api, headers: headers}, (error, response, body) => {
				if (!error && response.statusCode == 200) {
					var result = JSON.parse(body);
					if (result.length === 1) {
						/**
						 * A unique result should return from the filter. 
						 * Otherwise return null because we don't know who to delegate
						 */
						users = result[0];
					}
				}
				resolve(users);
			})  
		})
	}

	async function send_delegate_init_to_redis() {
		var status = 'NOT FOUND';
		var role_id = await get_roleid_promise(admin_id);
		// Must be a user admin (group admin)
		if (role_id) {
			//List of groups the group admin can manage
			var admins_groups = await user_admin_groups_promise(admin_id, role_id);
			// Get the target's user id and profile info
			var delegation_target_obj = await user_profile_promise(delegation_target);
			if (delegation_target_obj) {
				// List of groups the target is member of
				var users_groups = await groups_promise(delegation_target_obj.id);
				var admins_groups_ids = [];
				for(var i=0; i<admins_groups.length; i++){
					admins_groups_ids.push(admins_groups[i].id);
				}
				for(var i=0; i<users_groups.length; i++){
					if (admins_groups_ids.includes(users_groups[i].id)) {
						status = 'SUCCESS';
						var full_profile = delegation_target_obj.profile;
						var profile_group_names = [];
						for(var i=0; i<users_groups.length; i++){
							profile_group_names.push(users_groups[i].profile.name);
						}
						full_profile.groups = profile_group_names;

						var limit = time_limit // Auto expire the cache
						redis_client.set(sessionid, JSON.stringify(full_profile), 'EX', limit, redis.print);
						break;
					}
				}
			}
		}

		res.send({
			"status": status
		});
	}

	var delegation_target = req.body.delegation_target;
	if (!delegation_target) {
		res.status(400).send('Target is required');
	} else {
		send_delegate_init_to_redis();
	}

});


const port = process.env.PORT || 3000;
// app.listen(port, () => {
//   console.log(`App listening on port ${port}!`)
// });


// Create an HTTP service.
http.createServer(app).listen(80);
// Create an HTTPS service identical to the HTTP service.
https.createServer(options, app).listen(443);
