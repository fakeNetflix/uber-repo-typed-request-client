var globalRequest = require('request');
var Prober = require('airlock');
var EventEmitter = require('events').EventEmitter;
var enchain = require('enchain');

var validateShape = require('./validate-shape.js');
var makeTypedRequest = require('./make-typed-request.js');
var writeStats = require('./write-stats.js');
var errors = require('./errors.js');

module.exports = TypedRequestClient;

var chain = enchain({
    statsd: StatsdClient,
    validating: ValidatingClient,
    probing: ProbingClient
});

function TypedRequestClient(options) {
    if (!options) {
        throw errors.MissingOptions();
    }

    return chain(makeTypedRequest)
        .probing(options)
        .validating(options)
        .statsd(options)
        .valueOf();
}

function StatsdClient(client, options) {
    if (typeof options.clientName !== 'string') {
        throw errors.MissingClientName({
            optionsStr: JSON.stringify(options)
        });
    }
    if (typeof options.statsd !== 'object') {
        throw errors.MissingStatsd({
            optionsStr: JSON.stringify(options)
        });
    }

    var now = options.now || Date.now;

    var statsEmitter = new EventEmitter();
    writeStats(statsEmitter, {
        clientName: options.clientName,
        statsd: options.statsd
    });

    return statsdRequestClient;

    function statsdRequestClient(treq, opts, cb) {
        var resource = opts.resource;

        var beginRequest = now();
        statsEmitter.emit('makeRequest', resource);

        var beginProbe = now();
        client(treq, opts, onResponse);

        function onResponse(err, tres) {
            statsEmitter.emit('requestTime',
                resource, now() - beginProbe);

            if (err) {
                // TODO make this a better error.
                return cb(err);
            }

            statsEmitter.emit('statusCode',
                resource, tres.statusCode);

            statsEmitter.emit('totalTime',
                resource, now() - beginRequest);

            cb(null, tres);

        }
    }
}

function ValidatingClient(client, options) {
    return validatingClient;

    function validatingClient(treq, opts, cb) {
        var requestSchema = opts.requestSchema;
        var responseSchema = opts.responseSchema;

        var result = validateShape(treq, requestSchema);
        if (result.type === 'error') {
            result.error.treq = treq;
            result.error.schema = requestSchema;

            // TODO make this a better error.
            return cb(result.error);
        }

        client(result.ok, opts, onResponse);

        function onResponse(err, tres) {
            if (err) {
                return cb(err);
            }
            var result = validateShape(tres, responseSchema);

            if (result.type === 'error') {
                result.error.tres = tres;
                result.error.schema = responseSchema;

                // TODO make this a better error.
                return cb(result.error);
            }

            cb(null, result.ok);
        }
    }
}

function ProbingClient(client, options) {
    var reqOpts = {
        prober: Prober({
            enabled: true,
            title: 'typed-request-client',
            statsd: options.statsd
        }),
        request: options.request || globalRequest
    };

    return probingClient;

    function probingClient(treq, opts, cb) {
        var prober = reqOpts.prober;
        var thunk = client.bind(null, treq, reqOpts);
        prober.probe(thunk, cb);

    }
}
