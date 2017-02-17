const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const util = require('util');
const url = require('url');
const async = require('async');
const debug_ = require('debug');
const request = require('request');
const yaml = require('js-yaml');
const _ = require('lodash');
//TODO reintroduce config validation
const default_config_validator = require('./default-validator');
const proxy_validator = require('./proxy-validator');
const debug = debug_('agent:config');
const ioLib = require('./io');
const Handlebars = require('handlebars')

const Apid = function (io) {
    this.io = io || ioLib();
    this.deploymentId = undefined;
};

module.exports = function () {
    return new Apid();
};

Apid.prototype.get = function (options, callback) {
    this.apidEndpoint = options.apidEndpoint;
    request.get({url: this.apidEndpoint + '/deployments'}, function (err, response, body) {
        this._processResponse(this.apidEndpoint, err, response, body, (err, newConfig) => {
            if(err) {
              return callback(err);
            }


            if(response.statusCode == 200) {
              body = JSON.parse(body);
              this.deploymentId = body.deploymentId;
              this.etagValue = response.headers['etag'];
              reportStatus(options.apidEndpoint, err, body);
              var systemConfig = yaml.safeLoad(fs.readFileSync(options.systemConfigPath));
              newConfig = Object.assign(newConfig, systemConfig);
              callback(err, newConfig);
            }             
        });
    }.bind(this));
}

Apid.prototype.beginLongPoll = function(clientSocket, pollInterval) {
    if(!pollInterval) {
        pollInterval = 100;
    }
    var options = {
        url: this.apidEndpoint+'/deployments',
        headers: {
            "If-None-Match": this.etagValue,
        },
        qs: {
            block: pollInterval
        }
    }

    request.get(options, function (err, response, body) {
        if (err) {
            console.log("Error long polling apid.  Will retry...", err);
            this.beginLongPoll(clientSocket);
        }
        else if (response.statusCode == 304) {
            console.log("No change from apid reported.  Will retry...");
            this.beginLongPoll(clientSocket);
        } else {
            this._processResponse(this.apidEndpoint, err, response, body, function (err, newConfig) {
                body = JSON.parse(body);
                this.deploymentId = body.deploymentId;
                reportStatus(this.apidEndpoint, err, body);
                process.env.CONFIG = JSON.stringify(newConfig);
                clientSocket.sendMessage({command: 'reload'});
                this.beginLongPoll(clientSocket);
            }.bind(this));
        }
    }.bind(this));
}

/* place config defaults here */
const configDefaults = {
    'analytics-apid': {
        compress: true,
        apidEndpoint: '',
        flushInterval: 250
    }
};

const applyDefaults = function(config) {
    return _.merge({}, configDefaults, config);
}

const merge = function(baseConfig, override) {
    //apply vhost overrides
    override.system.vhosts.keys().forEach(vhost => {
        var toOverride;
        if (baseConfig.system.vhosts && (toOverride = baseConfig.system.vhosts.keys().find(key => key == vhost))) {
            vhost.keys().forEach(key => toOverride[key] = vhost[key]);
        }
    });

    //apply  system overrides
    var systemKeys = override.system.keys();
    delete systemKeys['vhosts'];
    systemKeys.forEach(key => baseConfig.system[key] = override.system[key]);

    //TODO implement merging for other entities.
    return baseConfig;
}

const reportStatus = function(apidBaseEndpoint, err, res) {

    var apidEndpoint =  apidBaseEndpoint + '/deployments/' + res['deploymentId'];

    request.post(apidEndpoint,
      {json:{ status: err ? "FAIL" : "SUCCESS" }},
      function(error, response, body) {
          if (error) {
              console.error("Failed to POST deployment status back to apid", error);
          }
          else {
              console.log("Successfully POSTed deployment status back to apid.");
          }
      });
}

/*
Extract proxies from each scope and bundle up into a top level 'proxies' object for convenience
 */
const formatConfig = function(config) {
    var gatheredProxies = [];
    Object.keys(config.scopes).forEach((scope) => {
        let curScope = config.scopes[scope]
        Object.keys(curScope.proxies).forEach((key) => {
            curScope.proxies[key]['scope'] = scope;
            //Edgemicro only uses this proxies array. We update each proxy 
            //To use the key as the proxy_name as it is a better identifier.
            curScope.proxies[key]['proxy_name'] = key;
            gatheredProxies.push(curScope.proxies[key])});
    })
    config.proxies = gatheredProxies;
    return config;
}

Apid.prototype.stitch = function(config) {
    var self = this;
    var scopes = {};

    config.forEach((deployment)=>{
      var scopeId = deployment['scopeId'];
      if(scopes[scopeId]) {
        scopes[scopeId].push(deployment);
      } else {
        scopes[scopeId] = [deployment];
      }
    });

    const mergeConfigs = (scopeConfig, bundleConfig) => {
      var obj = {};
      Object.keys(scopeConfig).forEach((k) => {
        obj[k] = scopeConfig[k];
      });

      Object.keys(bundleConfig).forEach((k) => {
        obj[k] = bundleConfig[k];
      });

      return obj;
    }

    var template = Handlebars.compile(fs.readFileSync(path.join(__dirname,'config-template.js')).toString())
    var values = {
        deployments: Object.keys(scopes).map((scopeId) => {
            var bundles = scopes[scopeId];
            return {
                scope: scopeId,
                /* Manually insert 6 spaces in order for proper YAML output, and insert bundle template variables */
                bundles: bundles
                  .map((bundle) => {
                    var scopeConfig = bundle['configuration'] || {};
                    var bundleConfig = bundle['bundleConfiguration'] || {};
                    var mergedConfig = mergeConfigs(scopeConfig, bundleConfig);
                    return Handlebars.compile(
                      self.io
                        .loadSync(bundle['uri'].replace('file://', ''))
                        .split('\n')
                        .map(l => { return '      ' + l; })
                        .join('\n'))(mergedConfig)
                  })
            }
        })
    }

    return template(values);

}

/**
 * read response status
 * @param url
 * @param err
 * @param response
 * @param body
 * @param cb
 * @private
 */
Apid.prototype._processResponse = function (url, err, response, body, cb) {
    const failed = err || (response && response.statusCode !== 200);
    console.info(failed ? 'warning:' : 'info:', 'config download from', url,
        'returned', response ? (response.statusCode + ' ' + response.statusMessage) :
            '', err ? err.message : '');
    if (err) {
        cb(err);
    } else if (response && response.statusCode !== 200) {
        cb(new Error(response.statusMessage));
    } else {
        body = JSON.parse(body);
        var config = yaml.safeLoad(this.stitch(body));
        if (fs.existsSync(process.env.CONFIG_OVERRIDES_PATH)) {
            localConfig = this.io.loadSync(process.env.CONFIG_OVERRIDES_PATH);
            cb(null, formatConfig(applyDefaults(merge(config, localConfig))));
        } else {
            cb(null, formatConfig(applyDefaults(config)));
        }
    }
}