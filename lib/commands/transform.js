var couchdb = require('../couchdb'),
    logger = require('../logger'),
    utils = require('../utils'),
    argParse = require('../args').parse,
    async = require('../../deps/async'),
    csv = require('../../deps/node-csv-parser/lib/csv'),
    json = require('../data-stream'),
    events = require('events'),
    url = require('url'),
    fs = require('fs');


exports.summary = 'Performs tranformations on JSON files';
exports.usage = '' +
'kanso transform TRANSFORMATION [OPTIONS] SOURCE TARGET\n' +
'\n' +
'Parameters:\n' +
'  TRANFORMATION    The operation to perform on SOURCE\n' +
'  SOURCE           The source file to use as input\n' +
'  TARGET           The filename for saving the output to\n' +
'\n' +
'Tranformations:\n' +
'  clear-ids    Clear the _id property of each document in the SOURCE file\n' +
'  add-ids      Fetch UUIDs from a CouchDB instance and use as _ids for\n' +
'               each doc in the SOURCE file.\n' +
'  csv          Convert a .csv file to JSON. Each row is converted to a\n' +
'               JSON object, using the values from the first row as\n' +
'               property names.\n' +
'\n' +
'Options:\n' +
'  -i, --indent    The number of spaces to use for indentation, by default\n' +
'                  output is not indented. Use --indent=tabs to use tabs.\n' +
'  -u, --url       The CouchDB instance to fetch UUIDs from. Defaults to\n' +
'                  http://localhost:5984';


var _uuid_cache = [];
var _uuid_em = new events.EventEmitter();
var _uuid_waiting = false;

exports.getUUID = function (db, cache, callback) {
    if (_uuid_cache.length) {
        return callback(null, _uuid_cache.shift());
    }
    else  {
        _uuid_em.once('new_uuids', function () {
            _uuid_em.removeListener('error', callback);
            exports.getUUID(db, cache, callback);
        });
        _uuid_em.once('error', callback);
        if (!_uuid_waiting) {
            db.uuids(cache, function (err, uuids) {
                if (err) {
                    _uuid_em.emit('error', err);
                }
                else {
                    _uuid_cache = uuids;
                    _uuid_waiting = false;
                    _uuid_em.emit('new_uuids');
                }
            });
            _uuid_waiting = true;
        }
    }
};


exports.run = function (args) {
    var a = argParse(args, {
        'indent': {match: ['--indent','-i'], value: true},
        'url': {match: ['--url','-u'], value: true}
    });
    var couchdb_url = a.options.url || 'http://localhost:5984';
    var indent = a.options.indent;
    if (indent !== 'tabs' && indent !== undefined) {
        indent = parseInt(indent, 10);
        if (isNaN(indent)) {
            logger.error('--indent option must be a number or "tabs"');
            return;
        }
    }
    var ilead = '';
    if (indent === 'tabs') {
        ilead = '\t';
    }
    else if (indent) {
        for (var i = 0; i < indent; i++) {
            ilead += ' ';
        }
    }
    a.options.ilead = ilead;

    // /_uuids is at the root couchdb instance level, not the db level
    var parsed = url.parse(couchdb_url);
    delete parsed.pathname;
    delete parsed.query;
    delete parsed.search;
    var couchdb_root_url = url.format(parsed);
    var db = couchdb(couchdb_root_url);

    a.options.couchdb_root_url = couchdb_root_url;

    var trans = a.positional[0];

    var source = a.positional[1];
    var target = a.positional[2];
    if (!source) {
        logger.error('No SOURCE file');
        logger.info('Usage: ' + exports.usage);
        return;
    }
    if (!target) {
        logger.error('No TARGET file');
        logger.info('Usage: ' + exports.usage);
        return;
    }

    if (trans === 'clear-ids') {
        exports.clearIDs(db, source, target, a.options);
    }
    else if (trans === 'add-ids') {
        exports.addIDs(db, source, target, a.options);
    }
    else if (trans === 'csv') {
        exports.csv(db, source, target, a.options);
    }
    else {
        if (trans){
            logger.error('Unknown transformation: ' + trans);
        }
        else {
            logger.error('No transformation specified');
        }
        logger.info('Usage: ' + exports.usage);
        return;
    }
};


exports.clearIDs = function (db, source, target, options) {
    var i = 0;
    var doctype = null;
    var p = json.createParseStream();
    var rstream = fs.createReadStream(source);
    rstream.pipe(p);

    var outfile = fs.createWriteStream(target);
    outfile.on('error', function (err) {
        logger.error(err);
    });
    outfile.on('open', function (fd) {
        outfile.on('drain', function () {
            rstream.resume();
        });
        p.on('type', function (type) {
            doctype = type;
            if (doctype === 'array') {
                outfile.write('[');
            }
        });
        p.on('doc', function (doc) {
            delete doc._id;
            var output = JSON.stringify(doc, null, options.ilead);
            if (doctype === 'array') {
                // prepent indent (because its in an array)
                output = options.ilead +
                         output.split('\n').join('\n' + options.ilead);
                // prepend end of previous doc
                output = (i > 0 ? ',\n': '\n') + output;
            }
            var flushed = outfile.write(output);
            if (!flushed) {
                rstream.pause();
            }
            i++;
            if (i % 100 === 0) {
                console.log('Transformed ' + i + ' docs');
            }
        });
        p.on('error', function (err) {
            logger.error(err);
        });
        p.on('end', function () {
            if (i % 100 !== 0) {
                console.log('Transformed ' + i + ' docs');
            }
            if (doctype === 'array') {
                outfile.write('\n]\n');
            }
            logger.end('Saved ' + i + ' docs to ' + target);
        });
    });
};


exports.addIDs = function (db, source, target, options) {
    utils.readJSON(source, function (err, docs) {
        if (err) {
            return logger.error(err);
        }
        if (!Array.isArray(docs)) {
            docs = [docs];
        }
        logger.info(
            'Fetching ' + docs.length + ' UUIDs from ' +
            options.couchdb_root_url
        );
        // number of uuids to fetch on each request
        var cache_num = Math.min(docs.length, 5000);
        async.map(docs, function (doc, cb) {
            if (doc._id) {
                logger.error(
                    'Document already has _id: ' + doc._id
                );
                cb(null, doc);
            }
            exports.getUUID(db, cache_num, function (err, uuid) {
                if (err) {
                    return cb(err);
                }
                doc._id = uuid;
                cb(null, doc);
            });
        },
        function (err, docs) {
            var output = JSON.stringify(docs, null, options.ilead);
            fs.writeFile(target, output, function (err) {
                if (err) {
                    return logger.error(err);
                }
                else {
                    logger.end('Saved ' + target);
                }
            });
        });
    });
};


exports.csv = function (db, source, target, options) {
    var headings = null;
    var results = [];

    var outfile = fs.createWriteStream(target);
    outfile.on('error', function (err) {
        logger.error(err);
    });
    outfile.on('open', function (fd) {
        outfile.write('[');
        var csvfile = csv().fromPath(source);
        outfile.on('drain', function () {
            csvfile.readStream.resume();
        });
        csvfile.on('data', function(data, index){
            if (index === 0) {
                headings = data;
            }
            else {
                var obj = {};
                for (var i = 0, len = data.length; i < len; i++) {
                    if (headings[i] && data[i] !== '') {
                        obj[headings[i]] = data[i];
                    }
                }
                var output = JSON.stringify(obj, null, options.ilead);
                // prepent indent (because its in an array)
                output = options.ilead +
                         output.split('\n').join('\n' + options.ilead);
                var flushed = outfile.write(
                    (index > 1 ? ',\n': '\n') + output
                );
                if (!flushed) {
                    csvfile.readStream.pause();
                }
            }
            if (index % 100 === 0) {
                console.log('Transformed ' + index + ' rows');
            }
        });
        csvfile.on('end', function(count){
            if (count % 100 !== 0) {
                console.log('Transformed ' + count + ' rows');
            }
            outfile.on('close', function () {
                logger.end('Saved ' + count + ' entries to ' + target);
            });
            outfile.write('\n]\n');
            outfile.end();
        });
        csvfile.on('error', function(error){
            logger.error(error.message);
        });
    });
};