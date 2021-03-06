'use strict';

const { memoize } = require('underscore');

const util = require('util');

const accountClient = require('abacus-accountclient');
const batch = require('abacus-batch');
const breaker = require('abacus-breaker');
const dbClient = require('abacus-dbclient');
const meteringClient = require('abacus-metering-config');
const oauth = require('abacus-oauth');
const ratingClient = require('abacus-rating-config');
const pricingClient = require('abacus-pricing-config');
const partition = require('abacus-partition');
const request = require('abacus-request');
const retry = require('abacus-retry');
const router = require('abacus-router');
const urienv = require('abacus-urienv');
const vcapenv = require('abacus-vcapenv');
const webapp = require('abacus-webapp');

const { ConnectionManager, Consumer, amqpMessageToJSON } = require('abacus-rabbitmq');
const { MessageHandler } = require('./lib/message-handler');
const Meter = require('./lib/meter');
const Normalizer = require('./lib/normalizer');
const createRequestRouting = require('./lib/request-routing');
const ProvisioningClient = require('./lib/provisioning-plugin-client');
const AccumulatorClient = require('./lib/accumulator-client');
const dbClientWrapper = require('./lib/db-client-wrapper');
const createRetriever = require('./lib/routes/document-retriver');

const brequest = retry(breaker(batch(request)));
const httpClient = {
  get: util.promisify(brequest.get),
  post: util.promisify(brequest.post)
};

const debug = require('abacus-debug')('abacus-usage-meter');

const dbalias = process.env.DBALIAS || 'db';

const uris = memoize(() =>
  urienv({
    [dbalias]: 5984,
    api : 9882,
    auth_server: 9883,
    provisioning: 9880,
    accumulator: 9200
  })
);

// Partitioning function that can be used for range queries
const checkKeyPart = partition.partitioner(
  partition.bucket,
  partition.period,
  partition.forward,
  partition.balance,
  true
);

// NB: collectorDb should be removed after retention period
// start
const dbPartitions = process.env.DB_PARTITIONS ? parseInt(process.env.DB_PARTITIONS) : 1;
const collectorKeyPart = partition.partitioner(
  partition.bucket,
  partition.period,
  partition.createForwardFn(dbPartitions, 4000),
  partition.balance,
  true
);
// end

// TODO: extact config

const prefetchLimit = process.env.PREFETCH_LIMIT || 100;
const rabbitUris =
  process.env.RABBIT_URI
    ? [process.env.RABBIT_URI]
    : vcapenv.serviceInstancesCredentials(process.env.RABBIT_SERVICE_NAME, 'uris');
const secured = process.env.SECURED === 'true';

const getMeteringPlan = util.promisify(meteringClient.plan);
const getPricingPlan = util.promisify(pricingClient.plan);

const getMeteringId = util.promisify(meteringClient.id);
const getRatingId = util.promisify(ratingClient.id);
const getPricingId = util.promisify(pricingClient.id);

const errorDb = dbClient(checkKeyPart, dbClient.dburi(uris()[dbalias], 'abacus-business-errors'));
const outputDb = dbClient(checkKeyPart, dbClient.dburi(uris()[dbalias], 'abacus-meter'));
// NB: collectorDb should be removed after retention period
const collectorInputDb = dbClient(collectorKeyPart,
  dbClient.dburi(uris()[dbalias], 'abacus-collector-collected-usage'));

const buildKeyFn = (usageDoc) => {
  return dbClient.tkuri(
    util.format(
      '%s/%s/%s/%s/%s/%s',
      usageDoc.organization_id,
      usageDoc.space_id,
      usageDoc.consumer_id,
      usageDoc.resource_id,
      usageDoc.plan_id,
      usageDoc.resource_instance_id
    ),
    usageDoc.processed_id);
};

let server;
let messageConsumer;

const startApp = async() => {
  debug('Starting meter app ...');
  const queueName = process.env.ABACUS_COLLECT_QUEUE || 'abacus-collect-queue';
  const token = oauth.cache(uris().api,
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET, 'abacus.usage.read abacus.usage.write');

  if(secured)
    await util.promisify(token.start)();

  const createAuthHeader = async() => {
    if(!secured)
      return undefined;

    return token();
  };

  debug('Creating provisioning client with url %s', uris().provisioning);
  const provisioningClient = new ProvisioningClient(uris().provisioning, createAuthHeader);

  const provisioningPluginClient = {
    getResourceType: (resourceId) => provisioningClient.getResourceType(resourceId),
    getPricingPlan: async(planId, pricingCountry) =>
      getPricingPlan(planId, pricingCountry, await createAuthHeader())
  };

  const accountPluginClient = {
    getAccount: async(usageDoc) => accountClient.getAccount(usageDoc, await createAuthHeader()),
    getMeteringId: async(organizationId, resourceType, planId, timestamp) =>
      getMeteringId(organizationId, resourceType, planId, timestamp, await createAuthHeader()),
    getRatingId: async(organizationId, resourceType, planId, timestamp) =>
      getRatingId(organizationId, resourceType, planId, timestamp, await createAuthHeader()),
    getPricingId: async(organizationId, resourceType, planId, timestamp) =>
      getPricingId(organizationId, resourceType, planId, timestamp, await createAuthHeader())
  };

  debug('Creating meter db client');

  debug('Creating normalizer with provisioning client %o and account client %o',
    provisioningPluginClient, accountPluginClient);
  const normalizer = new Normalizer(provisioningPluginClient, accountPluginClient);

  const meter = new Meter({
    getPlan: async(planId) => getMeteringPlan(planId, await createAuthHeader())
  });

  debug('Creating accumulator client with url %s', uris().accumulator);
  const urlBuilder = createRequestRouting(partition, process.env.ACCUMULATOR_APPS, uris().accumulator);
  const accumulatorClient = new AccumulatorClient(urlBuilder, httpClient, createAuthHeader);

  const meterOutputDbClient = dbClientWrapper(outputDb, buildKeyFn);
  const meterErrorDbClient = dbClientWrapper(errorDb, buildKeyFn);
  const collectorInputDbClient = dbClientWrapper(collectorInputDb, () => {
    throw new Error('Unsupported database PUT operation');
  });

  const messageHandler = new MessageHandler(normalizer, meter, accumulatorClient,
    meterOutputDbClient, meterErrorDbClient);
  const amqpMessageHandler = amqpMessageToJSON(messageHandler);

  const connectionManager = new ConnectionManager(rabbitUris[0]);

  debug(`Creating RabbitMQ consumer with queueName ${queueName} and prefetchLimit ${prefetchLimit}`);
  messageConsumer = new Consumer(connectionManager, queueName, prefetchLimit);

  await messageConsumer.process(amqpMessageHandler);

  const documentRetriever = createRetriever(meterOutputDbClient, meterErrorDbClient, collectorInputDbClient);
  const routes = router();
  routes.get('/v1/metering/collected/usage/t/:time/k/:key(*)',
    require('./lib/routes/routes')(documentRetriever));

  const app = webapp();
  app.use(routes);
  app.use(/^\/v1\/metering|^\/batch$/, oauth.validator(process.env.JWTKEY, process.env.JWTALGO));
  return app.listen();
};

const runCLI = async() => {
  server = await startApp();
};

process.on('SIGTERM', () => {
  debug('Meter is terminated');
  messageConsumer.close();
  if (server) server.close();
  process.exit(0);
});

module.exports = startApp;
module.exports.runCLI = runCLI;

