import { Arguments, Argv } from 'yargs';
import { ConfigurationParameters } from '../configure';
import dynamicContentClientFactory from '../../services/dynamic-content-client-factory';
import { Hub } from 'dc-management-sdk-js';
import { nothingExportedExit, promptToExportSettings, writeJsonToFile } from '../../services/export.service';
import { ExportBuilderOptions } from '../../interfaces/export-builder-options.interface';
import * as path from 'path';
import { FetchClientService, IndexEntry } from '../../services/fetch-client-service-class';

export const command = 'export <dir>';

export const desc = 'Export Indexes';

export const builder = (yargs: Argv): void => {
  yargs.positional('dir', {
    describe: 'Output directory for the exported Indexes',
    type: 'string'
  });
};

export const processIndexes = async (outputDir: string, hubToExport: Hub, indexes: any[]): Promise<void> => {
  const { id, name } = hubToExport;
  let dir = outputDir;
  if (outputDir.substr(-1) === path.sep) {
    dir = dir.slice(0, -1);
  }
  const file = path.basename(`indexes-${id}-${name}`, '.json');

  const uniqueFilename = dir + path.sep + file + '.json';

  if (!(await promptToExportSettings(uniqueFilename))) {
    return nothingExportedExit();
  }

  writeJsonToFile(uniqueFilename, indexes);

  process.stdout.write('Indexes exported successfully! \n');
};

export const handler = async (argv: Arguments<ExportBuilderOptions & ConfigurationParameters>): Promise<void> => {
  const { dir } = argv;

  const client = dynamicContentClientFactory(argv);
  const hub = await client.hubs.get(argv.hubId);

  const fetchClient = new FetchClientService();
  await fetchClient.init(argv);

  const finalIndexesListDetails: IndexEntry[] = [];

  // Retrieve list of indexes with details
  console.log(`\nRetrieve list of indexes with details:`);
  const indexesListDetails = await fetchClient.getIdexesDetailsList();
  console.log(`${indexesListDetails.map((x: any) => `${x.id}: ${x.name}`).join('\n')}`);

  // Check if there is any index and retrieve settings and assigned content types
  if (indexesListDetails.length > 0) {
    // Retrieve all index settings in parallel
    console.log(`\nRetrieve all index settings:`);
    const settingsList = await Promise.all(
      indexesListDetails.map((item: any) => fetchClient.getIndexSettings(item.id))
    );
    console.log(`${settingsList.map((x: any, i: number) => i).join(',')}`);

    // Retrieve all index assigned content types in parallel
    console.log(`\nRetrieve all assigned content types:`);
    const assignedContentTypesList: any[] = await Promise.all(
      indexesListDetails.map((item: any) => fetchClient.getIndexAssignedContentTypes(item.id))
    );
    console.log(
      `${assignedContentTypesList
        .map((x: any) => x[0] || {})
        .map((x: any) => x.contentTypeUri || 'none')
        .join('\n')}`
    );

    // For each assigned content type, get active and archived webhooks ref
    const activeContentWebhooks: any[] = [];
    const archivedContentWebhooks: any[] = [];
    assignedContentTypesList.forEach((types: any, i: number) => {
      if (types.length > 0) {
        const type: any = types[0];
        activeContentWebhooks[i] = type._links['active-content-webhook'].href.split('/').slice(-1)[0];
        archivedContentWebhooks[i] = type._links['archived-content-webhook'].href.split('/').slice(-1)[0];
      } else {
        activeContentWebhooks[i] = null;
        archivedContentWebhooks[i] = null;
      }
    });

    // Get Webhook settings
    const activeContentWebhooksList = await Promise.all(
      activeContentWebhooks.map((item: any) => (item ? hub.related.webhooks.get(item) : null))
    );
    const archivedContentWebhooksList = await Promise.all(
      archivedContentWebhooks.map((item: any) => (item ? hub.related.webhooks.get(item) : null))
    );
    const activeContentWebhooksPayload = activeContentWebhooksList.map((x: any) => x && x.customPayload.value);
    const archivedContentWebhooksPayload = archivedContentWebhooksList.map((x: any) => x && x.customPayload.value);

    // Extract list of replicas
    console.log(`\nRetrieve list of replicas:`);
    const replicas = settingsList.map((settings: any) => settings.replicas || []);
    console.log(`${replicas.map(x => JSON.stringify(x)).join('\n')}`);

    // Get replicas details
    console.log(`\nRetrieve list of replicas details by names:`);
    const replicaIndexesList: any = [];
    for (let i = 0; i < replicas.length; i++) {
      console.log(`Getting replica details for: ${JSON.stringify(replicas[i])}`);
      if (replicas[i].length > 0) {
        const replicasDetailsList = await Promise.all(replicas[i].map((item: any) => fetchClient.getIndexByName(item)));
        replicaIndexesList.push(replicasDetailsList);
      } else {
        replicaIndexesList.push([]);
      }
    }
    console.log(`${replicaIndexesList.map((x: any) => x.map((y: any) => y.id || 'none')).join('\n')}`);

    // Get replicas settings
    const replicaIndexSettingsList: any = [];
    console.log(`\nRetrieve all replica index settings:`);
    for (let i = 0; i < replicaIndexesList.length; i++) {
      console.log(`Getting replica settings for: ${JSON.stringify(replicaIndexesList[i].map((x: any) => x.id))}`);
      if (replicaIndexesList[i].length > 0) {
        const replicasSettingsList = await Promise.all(
          replicaIndexesList[i].map((item: any) => fetchClient.getIndexSettings(item.id))
        );
        replicaIndexSettingsList.push(replicasSettingsList);
      } else {
        replicaIndexSettingsList.push([]);
      }
    }

    // Create record with index details, settings and assigned content types
    indexesListDetails.forEach((item: any, i: number) => {
      // Add index entry if it's not a replica
      if (!item.parentId) {
        // Build replicas settings
        const replicasSettings = replicaIndexSettingsList[i].map((x: any, j: number) => ({
          id: replicaIndexesList[i][j].id,
          name: replicas[i][j],
          settings: x
        }));

        // Create index entry
        const indexEntry: IndexEntry = {
          id: item.id,
          indexDetails: item,
          settings: settingsList[i],
          replicasSettings,
          activeContentWebhook: activeContentWebhooksPayload[i],
          archivedContentWebhook: archivedContentWebhooksPayload[i]
        };

        // Add assigned content types if any
        if (assignedContentTypesList[i].length > 0) {
          indexEntry.indexDetails.assignedContentTypes = assignedContentTypesList[i];
        }

        finalIndexesListDetails.push(indexEntry);
      }
    });
  }

  await processIndexes(dir, hub, finalIndexesListDetails);
};
