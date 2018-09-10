import {
    Node, Mesh, AbstractMesh, PickingInfo, Tags,
    Tools as BabylonTools, Vector3, Quaternion,
    InstancedMesh, Animation, Engine
} from 'babylonjs';

import Editor from '../editor';
import SceneFactory from '../scene/scene-factory';

import { IAssetComponent, AssetElement, AssetContextMenu } from '../../shared/asset';
import { IStringDictionary } from '../typings/typings';
import Tools from '../tools/tools';
import Dialog from '../gui/dialog';

import { Prefab, PrefabNodeType } from './prefab';
import PrefabsHelpers from './helpers';

export default class PrefabAssetComponent implements IAssetComponent {
    // Public members
    public id: string = 'prefabs';
    public assetsCaption: string = 'Prefabs';
    public size: number = 100;

    public datas: AssetElement<Prefab>[] = [];

    public previewCanvas: HTMLCanvasElement = null;
    public previewEngine: Engine = null;

    /**
     * Constructor
     * @param editor the editor reference
     */
    constructor (public editor: Editor)
    { }

    /**
     * Creates a new prefab
     * @param sourceMesh the source mesh for the new prefab asset. Can be a single mesh or a root mesh
     */
    public async createPrefab (sourceMesh: Node): Promise<AssetElement<Prefab>> {
        const descendants = <Mesh[]> sourceMesh.getDescendants(false, n => n instanceof Node);
        const sourceMeshes = (descendants.length > 1 || descendants[0] !== sourceMesh) ? [sourceMesh].concat(descendants) : [sourceMesh];

        // Default asset
        const asset = <AssetElement<Prefab>> {
            name: await Dialog.CreateWithTextInput('Prefab name?'),
            data: {
                isPrefab: true,
                nodes: sourceMeshes.map(m => m.name),
                nodeIds: sourceMeshes.map(m => m.id),
                instances: { },
                sourceMeshes: sourceMeshes,
                sourceMesh: sourceMesh,
                sourceInstances: { }
            }
        };

        // Configure dictionaries
        sourceMeshes.forEach(m => {
            asset.data.instances[m.name] = [];
            asset.data.sourceInstances[m.name] = [];
        });

        // Add asset
        this.onAddAsset(asset);
        this.editor.assets.refresh(this.id);

        return asset;
    }

    /**
     * On the user adds a new prefab asset
     * @param asset the asset to add in the collection
     */
    public onAddAsset (asset: AssetElement<Prefab>): void {
        this.datas.push(asset);
        this.buildInstances([asset]);
    }

    /**
     * On the user removes a prefab from his library
     * @param asset the asset to remove
     */
    public onRemoveAsset (asset: AssetElement<Prefab>): void {
        // Serialize assets to save instances configuration
        // and allow the undo/redo
        const saved = this.onSerializeAssets();
        const assetIndex = this.datas.indexOf(asset);

        if (assetIndex !== -1)
            asset.data.instances = saved[assetIndex].data.instances;
        
        // Remove all instances in the scene
        const instancesDictionary = asset.data.sourceInstances;
        for (const key in instancesDictionary) {
            const instances = instancesDictionary[key];
            instances.forEach(i => i.dispose());
            
            instancesDictionary[key] = [];
        }

        // Remove from library
        const index = this.datas.indexOf(asset);
        if (index !== -1)
            this.datas.splice(index, 1);

        // Update graph
        this.editor.graph.clear();
        this.editor.graph.fill();
    }

    /**
     * On the user drops an asset in the scene
     * @param targetMesh the mesh under the pointer
     * @param asset the asset being dropped
     * @param pickInfo the pick info once the user dropped the asset
     */
    public onDragAndDropAsset (targetMesh: AbstractMesh, asset: AssetElement<Prefab>, pickInfo: PickingInfo): void {
        // Parent
        const parent = asset.data.sourceMesh instanceof Mesh ? asset.data.sourceMesh.createInstance(asset.name + ' (Prefab)') : this._cloneNode(asset.data.sourceMesh);
        parent.id = BabylonTools.RandomId();
        parent.position.copyFrom(pickInfo.pickedPoint);
        parent.doNotSerialize = true;

        Tags.AddTagsTo(parent, 'prefab-master');
        asset.data.sourceInstances[asset.data.sourceMesh.name].push(parent);

        // Descendants
        if (asset.data.sourceMeshes.length > 1) {
            asset.data.sourceMeshes.forEach((m, index) => {
                // Skip parent
                if (index === 0)
                    return;
                
                const instance = m instanceof Mesh ? m.createInstance(asset.name) : this._cloneNode(m);
                instance.id = BabylonTools.RandomId();
                instance.parent = parent;
                instance.doNotSerialize = true;

                // Register instance
                Tags.AddTagsTo(instance, 'prefab');
                asset.data.sourceInstances[m.name].push(instance);
            });
        }

        SceneFactory.AddToGraph(this.editor, parent);
        Tags.RemoveTagsFrom(parent, 'added');

        // Select
        if (parent instanceof AbstractMesh)
            this.editor.scenePicker.setGizmoAttachedMesh(parent);
        
        this.editor.core.onSelectObject.notifyObservers(parent);
    }

    /**
     * On the user saves the editor project
     */
    public onSerializeAssets (): AssetElement<Prefab>[] {
        return this.datas.map(d => {
            const instances: IStringDictionary<any[]> = { };
            d.data.sourceMeshes.forEach(m => {
                instances[m.name] = [];
                if (m instanceof Mesh) {
                    m.instances.forEach(i => {
                        if (Tags.MatchesQuery(i, 'prefab') || Tags.MatchesQuery(i, 'prefab-master'))
                            instances[m.name].push(i.serialize());
                    });
                }
                else {
                    instances[m.name].push(m.serialize());
                }
            });

            return {
                name: d.name,
                img: d.img,
                data: {
                    isPrefab: true,
                    nodes: d.data.sourceMeshes.map(m => m.name),
                    nodeIds: d.data.sourceMeshes.map(m => m.id),
                    instances: instances
                }
            };
        });
    }
    
    /**
     * On the user loads the editor project
     * @param data the previously saved data
     */
    public onParseAssets (data: AssetElement<Prefab>[]): void {
        this.datas = data;

        const count = this.buildInstances(this.datas);
        if (count) {
            this.editor.graph.clear();
            this.editor.graph.fill();
        }
    }

    /**
     * On the assets panel requires the assets stored in this
     * asset component
     */
    public async onGetAssets (): Promise<AssetElement<Prefab>[]> {
        // Create engine
        if (!this.previewCanvas) {
            this.previewCanvas = Tools.CreateElement<HTMLCanvasElement>('canvas', 'PrefabAssetComponentCanvas', {
                'width': '100px',
                'height': '100px',
                'visibility': 'hidden'
            });
            document.body.appendChild(this.previewCanvas);
        }

        if (!this.previewEngine)
            this.previewEngine = new Engine(this.previewCanvas);
        
        // Create previews
        const promises: Promise<void>[] = [];

        for (const d of this.datas) {
            if (!d.img) {
                promises.push(PrefabsHelpers.CreatePreview(d, this.previewEngine).then(() => {
                    const adp = this.editor.assets.getAssetPreviewData(d);
                    if (adp) {
                        adp.img.src = d.img;
                        w2utils.unlock(adp.parent);
                    }
                }));

                setTimeout(() => {
                    const adp = this.editor.assets.getAssetPreviewData(d);
                    if (adp) {
                        adp.img.src = '';
                        w2utils.lock(adp.parent, '', true);
                    }
                }, 0);
            }
        }

        // Dispose
        Promise.all(promises).then(() => {
            if (this.previewEngine) {
                this.previewEngine.dispose();
                this.previewEngine = null;
            }

            if (this.previewCanvas) {
                this.previewCanvas.remove();
                this.previewCanvas = null;
            }
        });

        return this.datas;
    }

    /**
     * On the user wants to show the context menu on the asset
     */
    public onContextMenu (): AssetContextMenu[] {
        return [
            {
                // Rename
                id: 'rename',
                text: 'Rename...',
                img: 'icon-export',
                callback: async (asset: AssetElement<Prefab>) => {
                    const name = await Dialog.CreateWithTextInput('Asset name...');
                    asset.name = name;

                    const adp = this.editor.assets.getAssetPreviewData(asset);
                    adp.title.innerText = name;
                }
            }
        ];
    }

    /**
     * Builds the instances of the given data
     * @param data the given data
     */
    public buildInstances (data: AssetElement<Prefab>[]): number {
        const scene = this.editor.core.scene;
        let count = 0;

        data.forEach(d => {
            // Misc.
            d.data.sourceMeshes = [];
            d.data.sourceInstances = { };

            // Get source mesh
            const source = <PrefabNodeType> (scene.getNodeByID(d.data.nodeIds[0]) || scene.getNodeByName(d.data.nodes[0]));
            if (!source)
                return;

            d.data.sourceMesh = source;
            d.data.sourceMeshes.push(source);

            // Create master instances
            const parents = d.data.instances[source.name];
            d.data.sourceInstances[source.name] = [];

            parents.forEach(p => {
                const parent = source instanceof Mesh ? source.createInstance(p.name) : this._cloneNode(source);
                parent.id = p.id;
                parent.doNotSerialize = true;

                d.data.sourceInstances[source.name].push(parent);
                Tags.AddTagsTo(parent, 'prefab-master');

                if (parent instanceof InstancedMesh)
                    this._configureInstance(p, parent);

                count++;
            });

            // Recreate children instances
            for (let i = 1; i < d.data.nodeIds.length; i++) {
                const node = <PrefabNodeType> (scene.getNodeByID(d.data.nodeIds[i]) || scene.getNodeByName(d.data.nodes[i]));
                if (!node)
                    continue;

                d.data.sourceMeshes.push(node);
                d.data.sourceInstances[node.name] = [];

                d.data.instances[node.name].forEach(inst => {
                    const instance = node instanceof Mesh ? node.createInstance(inst.name) : this._cloneNode(node);
                    instance.id = inst.id;
                    instance.parent = this.editor.core.scene.getNodeByID(inst.parentId);
                    instance.doNotSerialize = true;

                    d.data.sourceInstances[node.name].push(instance);
                    Tags.AddTagsTo(instance, 'prefab');

                    if (instance instanceof InstancedMesh)
                        this._configureInstance(inst, instance);

                    count++;
                });
            }

            // Clean data
            d.data.instances = { };
        });

        // Return number of instances created
        return count;
    }

    /**
     * Sets all the instances serializable or not
     * @param serializable if the instances are serializable
     */
    public setSerializable (serializable: boolean): void {
        this.datas.forEach(d => {
            for (const key in d.data.sourceInstances) {
                const instances = d.data.sourceInstances[key];
                instances.forEach(i => i.doNotSerialize = !serializable);
            }
        });
    }

    // Clones the given node
    private _cloneNode (node: any): PrefabNodeType {
        if (node.clone)
            return node.clone(node.name + ' Cloned', node.parent);

        return null;
    }

    // Configures the given instance
    private _configureInstance (data: any, instance: InstancedMesh): void {
        instance.id = instance.id || BabylonTools.RandomId();
        instance.position = Vector3.FromArray(data.position || data._position);
        instance.scaling = Vector3.FromArray(data.scaling || data._scaling);
        instance.checkCollisions = instance.sourceMesh.checkCollisions;

        if (data.rotationQuaternion || data._rotationQuaternion) {
            instance.rotationQuaternion = Quaternion.FromArray(data.rotationQuaternion || data._rotationQuaternion);
        } else if (data.rotation || data._rotation) {
            instance.rotation = Vector3.FromArray(data.rotation || data._rotation);
        }

        if (data.animations) {
            for (let i = 0; i < data.animations.length; i++) {
                const parsedAnimation = data.animations[i];
                instance.animations.push(Animation.Parse(parsedAnimation));
            }
        }
    }
}
