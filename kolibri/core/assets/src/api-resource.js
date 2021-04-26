import logger from 'kolibri.lib.logging';
import find from 'lodash/find';
import matches from 'lodash/matches';
import isEqual from 'lodash/isEqual';
import urls from 'kolibri.urls';
import cloneDeep from './cloneDeep';
import ConditionalPromise from './conditionalPromise';
import plugin_data from 'plugin_data';

export const logging = logger.getLogger(__filename);

const contentCacheKey = plugin_data.contentCacheKey;

/** Class representing a single API resource object */
export class Model {
  /**
   * Create a model instance.
   * @param {object} data - data to insert into the model at creation time - should include at
   * least an id for fetching, or data an no id if the intention is to save a new model.
   * @param {object} getParams - an object of parameters to be parsed into GET parameters on the
   * fetch.
   * @param {Resource} resource - object of the Resource class, specifies the urls and fetching
   * behaviour for the model.
   */
  constructor(data, getParams = {}, resource, url) {
    this.resource = resource;
    if (!this.resource) {
      throw new TypeError('resource must be defined');
    }

    if (!data) {
      throw new TypeError('data must be defined');
    }

    if (typeof data !== 'object') {
      throw new TypeError('data must be an object');
    }

    if (Object.keys(data).length === 0) {
      throw new TypeError('data must be instantiated with some data');
    }

    // Assign any data to the attributes property of the Model.
    this.attributes = {};
    this.set(data);

    this.getParams = getParams;

    this.url = url;

    this.synced = false;
    // Set this property to track whether this model exists on the server or not
    // Assume it does until we learn otherwise
    this.new = true;

    // Keep track of any unresolved promises that have been generated by async methods of the Model
    this.promises = [];
  }

  /**
   * Method to fetch data from the server for this particular model.
   * @param {boolean} [force=false] - fetch whether or not it's been synced already.
   * @returns {Promise} - Promise is resolved with Model attributes when the XHR successfully
   * returns, otherwise reject is called with the response object.
   */
  fetch(force = false) {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          if (!force && this.synced) {
            resolve(this.data);
          } else {
            this.synced = false;
            // Do a fetch on the URL.
            this.resource.client({ url: this.url, params: this.getParams }).then(
              response => {
                // Set the retrieved Object onto the Model instance.
                this.set(response.data);
                // Flag that the Model has been fetched.
                this.synced = true;
                // Flag that the model exists on the server.
                this.new = false;
                // Resolve the promise with the attributes of the Model.
                resolve(this.data);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              },
              response => {
                this.resource.logError(response);
                reject(response);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              }
            );
          }
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  /**
   * Method to save data to the server for this particular model.
   * @param {object} attrs - an object of attributes to be saved on the model.
   * @param {Boolean} exists - a Boolean flag to override the default new behaviour
   * @returns {Promise} - Promise is resolved with Model attributes when the XHR successfully
   * returns, otherwise reject is called with the response object.
   */
  save(attrs, exists = false) {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          let payload = {};
          if (this.synced) {
            // Model is synced with the server, so we can do dirty checking.
            Object.keys(attrs).forEach(key => {
              if (!isEqual(attrs[key], this.attributes[key])) {
                payload[key] = attrs[key];
              }
            });
          } else {
            payload = {
              ...this.attributes,
              ...attrs,
            };
          }
          if (!Object.keys(payload).length) {
            // Nothing to save, so just resolve the promise now.
            resolve(this.data);
          } else {
            this.synced = false;
            let url;
            let clientObj;
            if (!this.new || exists) {
              // If this Model is not new, then can do a PATCH against the Model
              url = this.url;
              clientObj = { url: url, method: 'patch', data: payload, params: this.getParams };
            } else {
              // Otherwise, must POST to the Collection endpoint to create the Model
              url = this.resource.collectionUrl();
              clientObj = { url: url, method: 'post', data: payload, params: this.getParams };
            }
            // Do a save on the URL.
            this.resource.client(clientObj).then(
              response => {
                const oldId = this.id;
                // Set the retrieved Object onto the Model instance.
                this.set(response.data);
                // if the model did not used to have an id and now does, add it to the cache.
                if (!oldId && this.id) {
                  this.resource.addModel(this, this.getParams);
                }
                // Flag that the Model has been fetched.
                this.synced = true;
                // Flag that the model exists on the server.
                this.new = false;
                // Resolve the promise with the Model.
                resolve(this.data);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              },
              response => {
                this.resource.logError(response);
                reject(response);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              }
            );
          }
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  /**
   * Method to delete model.
   * @param {Integer} id - target model's id.
   * @returns {Promise} - Promise is resolved with target model's id
   * returns, otherwise reject is called with the response object.
   */
  delete() {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          if (!this.id) {
            // Nothing to delete, so just resolve the promise now.
            reject('Can not delete model that we do not have an id for');
          } else {
            // Otherwise, DELETE the Model
            const clientObj = { url: this.url, method: 'delete', params: this.getParams };
            this.resource.client(clientObj).then(
              () => {
                // delete this instance
                this.resource.removeModel(this);
                // Set a flag so that any collection containing this can ignore this model
                this.deleted = true;
                // Any collection containing this model is now probably out of date,
                // set synced to false to ensure that they update their data on fetch
                this.synced = false;
                this.new = true;
                // Resolve the promise with the id.
                // Vuex will use this id to delete the model in its state.
                resolve(this.id);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              },
              response => {
                this.resource.logError(response);
                reject(response);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              }
            );
          }
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  get url() {
    return this._url ? this._url : this.resource.modelUrl(this.id);
  }

  set url(url) {
    this._url = url;
  }

  get id() {
    return this.attributes[this.resource.idKey];
  }

  get data() {
    return cloneDeep(this.attributes);
  }

  set(attributes) {
    // force IDs to always be strings - this should be changed on the server-side too
    if (attributes && this.resource.idKey in attributes) {
      if (attributes[this.resource.idKey]) {
        // don't stringigy null or undefined.
        attributes[this.resource.idKey] = String(attributes[this.resource.idKey]);
      }
    }
    Object.assign(this.attributes, cloneDeep(attributes));
  }
}

/** Class representing a 'view' of a single API resource.
 *  Contains different Model objects, depending on the parameters passed to its fetch method.
 */
export class Collection {
  /**
   * Create a Collection instance.
   * @param {Object} getParams - Default parameters to use when fetching data from the server.
   * @param {Object[]|Model[]} data - Data to prepopulate the collection with,
   * useful if wanting to save multiple models.
   * @param {Resource} resource - object of the Resource class, specifies the urls and fetching
   * behaviour for the collection.
   * @param {Function} url - a url function for this collection if undefind default to list url
   */
  constructor(getParams = {}, data = [], resource, url) {
    this.resource = resource;
    this.getParams = getParams;
    if (!this.resource) {
      throw new TypeError('resource must be defined');
    }
    this.models = [];
    this._model_map = {};
    this.url = url;
    this.synced = false;
    this.new = true;
    this.set(data);
    // Keep track of any unresolved promises that have been generated by async methods of the Model
    this.promises = [];
  }

  /**
   * Method to fetch data from the server for this collection.
   * @param {boolean} force - fetch whether or not it's been synced already.
   * @returns {Promise} - Promise is resolved with Array of Model attributes when the XHR
   * successfully returns, otherwise reject is called with the response object.
   */
  fetch(force = false) {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          if (!force && this.synced) {
            resolve(this.data);
          } else {
            this.synced = false;
            this.resource.client({ url: this.url, params: this.getParams }).then(
              response => {
                // Set response object - an Array - on the Collection to record the data.
                // First check that the response *is* an Array
                if (Array.isArray(response.data)) {
                  this.clearCache();
                  this.set(response.data);
                  // Mark that the fetch has completed.
                  this.synced = true;
                  // Flag that the collection exists on the server.
                  this.new = false;
                } else if (typeof (response.data || {}).results !== 'undefined') {
                  // If it's not, there are two possibilities - something is awry,
                  // or we have received data with additional metadata!
                  this.clearCache();
                  // Collections with additional metadata have 'results' as their results
                  // object so interpret this as such.
                  this.set(response.data.results);
                  this.metadata = {};
                  Object.keys(response.data).forEach(key => {
                    if (key !== 'results') {
                      this.metadata[key] = response.data[key];
                    }
                  });
                  // Mark that the fetch has completed.
                  this.synced = true;
                  // Flag that the collection exists on the server.
                  this.new = false;
                } else {
                  // It's all gone a bit Pete Tong.
                  logging.error('Data appears to be malformed', response.data);
                  reject(response);
                }
                resolve(this.data);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              },
              response => {
                this.resource.logError(response);
                reject(response);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              }
            );
          }
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  /**
   * Method to save data to the server for this particular collection.
   * Can only currently be used to save new models to the server, not do bulk updates.
   * @returns {Promise} - Promise is resolved with list of collection attributes when the XHR
   * successfully returns, otherwise reject is called with the response object.
   */
  save(data = []) {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          if (!data.length && !this.new) {
            // Collection is not new so constituent models must be synced, so already saved.
            reject('Cannot update collections, only create them');
            // Clean up the reference to this promise
            this.promises.splice(this.promises.indexOf(promise), 1);
            return;
          }
          this.synced = false;
          const url = this.resource.collectionUrl();
          const payload = data.length ? data : this.data;
          const clientObj = { url: url, data: payload, method: 'post' };
          // Do a save on the URL.
          this.resource.client(clientObj).then(
            response => {
              if (Array.isArray(response.data)) {
                this.clearCache();
                this.set(response.data);
                // Mark that the fetch has completed.
                this.synced = true;
                // Flag that the collection exists on the server.
                this.new = false;
              } else {
                // It's all gone a bit Pete Tong.
                logging.debug('Data appears to be malformed', response.data);
                reject(response);
              }
              // Resolve the promise with the Collection.
              resolve(this.data);
              // Clean up the reference to this promise
              this.promises.splice(this.promises.indexOf(promise), 1);
            },
            response => {
              this.resource.logError(response);
              reject(response);
              // Clean up the reference to this promise
              this.promises.splice(this.promises.indexOf(promise), 1);
            }
          );
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  /**
   * Method to delete a collection.
   * @returns {Promise} - Promise is resolved with list of collection ids
   * returns, otherwise reject is called with the response object.
   */
  delete() {
    const promise = new ConditionalPromise((resolve, reject) => {
      Promise.all(this.promises).then(
        () => {
          if (!Object.keys(this.getParams).length) {
            // Cannot do a DELETE unless we are filtering by something,
            // to prevent dangerous bulk deletes
            reject('Can not delete unfiltered collection (collection without any GET params');
          } else {
            // Otherwise, DELETE the Collection
            const clientObj = {
              url: this.resource.collectionUrl(),
              method: 'delete',
              params: this.getParams,
            };
            this.resource.client(clientObj).then(
              () => {
                // delete this instance
                this.resource.removeCollection(this);
                // delete and remove each model
                this.models.forEach(model => {
                  model.deleted = true;
                  this.resource.removeModel(model);
                });
                // Vuex will use this id to delete the model in its state.
                resolve(this.models.map(model => model.id));
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              },
              response => {
                this.resource.logError(response);
                reject(response);
                // Clean up the reference to this promise
                this.promises.splice(this.promises.indexOf(promise), 1);
              }
            );
          }
        },
        reason => {
          reject(reason);
        }
      );
    });
    this.promises.push(promise);
    return promise;
  }

  get url() {
    return this._url ? this._url : this.resource.collectionUrl();
  }

  set url(url) {
    this._url = url;
  }

  /**
   * Clear this Collection's cache of models.
   */
  clearCache() {
    // Reset current models.
    this.models = [];
    this._model_map = {};
  }

  /**
   * Make a model a member of the collection - record in the models Array, and in the mapping
   * from id to model. Will automatically instantiate Models for data passed in as objects, and
   * deduplicate within the collection.
   * @param {(Object|Model|Object[]|Model[])} models - Either an Array or single instance of an
   * object or Model.
   */
  set(models) {
    let modelsToSet;
    if (!Array.isArray(models)) {
      modelsToSet = [models];
    } else {
      modelsToSet = models;
    }
    // Check if this collection is using dynamic field assignment, as we should cache these in a
    // separate namespace.
    const getParams = this.getParams.fields ? { fields: this.getParams.fields } : {};
    modelsToSet.forEach(model => {
      // Note: this method ensures instantiation deduplication of models within the collection
      // and across collections.

      const setModel = this.resource.addModel(model, getParams);
      let cacheKey;
      if (setModel.id) {
        cacheKey = setModel.id;
      } else {
        cacheKey = this.resource.__cacheKey(setModel.attributes);
      }
      if (!this._model_map[cacheKey]) {
        this._model_map[cacheKey] = setModel;
        this.models.push(setModel);
      }
    });
  }

  get data() {
    const data = this.models.filter(model => !model.deleted).map(model => model.data);
    // Return the data from the models, not the models themselves.
    if (!this.metadata) {
      // If no additional metadata just return the results directly.
      return data;
    }
    // Otherwise resolve the data in the form it was received originally
    return {
      results: data,
      ...cloneDeep(this.metadata),
    };
  }

  get synced() {
    // We only say the Collection is synced if it, itself, is synced, and all its
    // constituent models are also.
    return this.models.reduce((synced, model) => synced && model.synced, this._synced);
  }

  /**
   * Set this Collection as synced or not, for true, will also set all models cached in it
   * as synced.
   * @param  {Boolean} value Is this Collection synced or not?
   */
  set synced(value) {
    this._synced = value;
    if (value) {
      this.models.forEach(model => {
        model.synced = true;
      });
    }
  }

  get new() {
    // We only say the Collection is new if it, itself, is not new, and all its
    // constituent models are also not new.
    return this.models.reduce((isNew, model) => isNew && model.new, this._new);
  }

  /**
   * Set this Collection as new or not, for false, will also set all models cached in it
   * as not new.
   * @param  {Boolean} value Is this Collection new or not?
   */
  set new(value) {
    this._new = value;
    if (!value) {
      this.models.forEach(model => {
        model.new = false;
      });
    }
  }
}

/** Class representing a single API resource.
 *  Contains references to all Models that have been fetched from the server.
 *  Can also be subclassed in order to create custom behaviour for particular API resources.
 */
export class Resource {
  /**
   * Create a resource with a Django REST API name corresponding to the name parameter.
   */
  constructor({
    name,
    idKey = 'id',
    namespace = 'core',
    useContentCacheKey = false,
    ...options
  } = {}) {
    if (!name) {
      throw ReferenceError('Resource must be instantiated with a name property');
    }
    this.name = `kolibri:${namespace}:${name}`;
    this.idKey = idKey;
    this.useContentCacheKey = useContentCacheKey;
    const optionsDefinitions = Object.getOwnPropertyDescriptors(options);
    Object.keys(optionsDefinitions).forEach(key => {
      Object.defineProperty(this, key, optionsDefinitions[key]);
    });
    this.clearCache();
  }

  __cacheKey(...params) {
    const allParams = Object.assign({}, ...params);
    // Sort keys in order, then assign those keys to an empty object in that order.
    // Then stringify to create a cache key.
    return JSON.stringify(
      Object.assign(
        {},
        ...Object.keys(allParams)
          .sort()
          .map(paramKey => ({
            [paramKey]: paramKey === this.idKey ? String(allParams[paramKey]) : allParams[paramKey],
          }))
      )
    );
  }

  __cacheName(endpointName) {
    return endpointName ? `endpoint-${endpointName}` : 'default';
  }

  __getCache(type, endpointName) {
    const cacheName = this.__cacheName(endpointName);
    this[type][cacheName] = this[type][cacheName] || {};
    return this[type][cacheName];
  }

  __collectionCache(endpointName) {
    return this.__getCache('collections', endpointName);
  }

  __modelCache(endpointName) {
    return this.__getCache('models', endpointName);
  }

  /**
   * @param {Object} getParams - default parameters to use for Collection fetching.
   * @returns {Collection} - Returns an instantiated Collection object.
   */
  getCollection(getParams = {}, endpointName, detailId) {
    const cache = this.__collectionCache(endpointName);
    const key = this.__cacheKey(getParams, { detailId });
    if (!cache[key]) {
      cache[key] = this.createCollection(getParams, [], endpointName, detailId);
    }
    return cache[key];
  }

  /**
   * Optionally pass in data and instantiate a collection for saving that data or fetching
   * data from the resource.
   * @param {Object} getParams - default parameters to use for Collection fetching.
   * @param {Object[]} data - Data to instantiate the Collection - see Model constructor for
   * details of data.
   * @returns {Collection} - Returns an instantiated Collection object.
   */
  createCollection(getParams = {}, data = [], endpointName, detailId) {
    let url;
    if (endpointName && detailId) {
      url = this.getUrlFunction(endpointName)(detailId);
    } else if (endpointName) {
      url = this.getUrlFunction(endpointName)();
    }
    const cache = this.__collectionCache(endpointName);
    const key = this.__cacheKey(getParams, { detailId });
    const collection = new Collection(getParams, data, this, url);
    cache[key] = collection;
    return collection;
  }

  /**
   * Get a model by id
   * @param {String} id - The primary key of the Model instance.
   * @returns {Model} - Returns a Model instance.
   */
  getModel(id, getParams = {}, endpointName) {
    const cache = this.__modelCache(endpointName);
    const cacheKey = this.__cacheKey({ [this.idKey]: id }, getParams);
    if (!cache[cacheKey]) {
      this.createModel({ [this.idKey]: id }, getParams, endpointName);
    }
    return cache[cacheKey];
  }

  /**
   * Find a model by its attributes - will return first model found that matches
   * @param  {Object} attrs Hash of attributes to search by
   * @param  {string} endpointName name of endpoint to search model cache
   * @return {Model}       First matching Model
   */
  findModel(attrs, endpointName) {
    const cache = this.__modelCache(endpointName);
    return find(cache, model => matches(attrs)(model.attributes));
  }

  /**
   * Add a model to the resource for deduplication, dirty checking, and tracking purposes.
   * @param {Object} data - The data for the model to add.
   * @returns {Model} - Returns the instantiated Model.
   */
  createModel(data, getParams = {}, endpointName) {
    let url;
    if (endpointName) {
      const detailId = data[this.idKey];
      url = this.getUrlFunction(endpointName)(detailId);
    }
    const model = new Model(data, getParams, this, url);
    return this.addModel(model, getParams, endpointName);
  }

  /**
   * Add a model to the resource for deduplication, dirty checking, and tracking purposes.
   * @param {Object|Model} model - Either the data for the model to add, or the Model itself.
   * @returns {Model} - Returns the instantiated Model.
   */
  addModel(model, getParams = {}, endpointName) {
    if (!(model instanceof Model)) {
      return this.createModel(model, getParams, endpointName);
    }
    // Add to the model cache using the default key if id is defined.
    const cache = this.__modelCache(endpointName);
    let cacheKey;
    if (model.id) {
      cacheKey = this.__cacheKey({ [this.idKey]: model.id }, model.getParams);
      if (!cache[cacheKey]) {
        cache[cacheKey] = model;
      } else {
        cache[cacheKey].set(model.attributes);
      }
    } else {
      // Otherwise use a hash of the models attributes to create a temporary cache key
      cacheKey = this.__cacheKey(model.attributes);
      cache[cacheKey] = model;
      // invalidate collection cache because this new model may be included in a collection
      this.collections = {};
    }
    return cache[cacheKey];
  }

  /**
   * Fetch a model from a resource
   * @param  {string} options.id               id of the model to fetch
   * @param  {Object} [options.getParams={}]   any getParams to use when fetching the model
   * @param  {Boolean} [force=false]           whether to respect the cache when fetching
   * @return {Promise}                         Promise that resolves on fetch with the model data
   */
  fetchModel({ id, getParams = {}, force = false } = {}) {
    if (!id) {
      throw TypeError('An id must be specified');
    }
    return this.getModel(id, getParams).fetch(force);
  }

  /**
   * Save a model to a resource
   * @param  {string} [options.id]             id of the model to save
   * @param  {Object} [options.getParams={}]   any getParams to use when saving the model
   * @param  {Object} data                     data to save on the model
   * @param  {Boolean} [exists=false]          flag that this model exists on the server already
   * @return {Promise}                         Promise that resolves on save with the model data
   */
  saveModel({ id, getParams = {}, data = {}, exists = false } = {}) {
    if (!id) {
      return this.createModel(data, getParams).save();
    }
    return this.getModel(id, getParams).save(data, exists);
  }

  /**
   * Delete a model from a resource
   * @param  {string} options.id               id of the model to delete
   * @param  {Object} [options.getParams={}]   any getParams to use when deleting the model
   * @return {Promise}                         Promise that resolves on delete with the model id
   */
  deleteModel({ id, getParams = {} } = {}) {
    if (!id) {
      throw TypeError('An id must be specified');
    }
    return this.getModel(id, getParams).delete();
  }

  /**
   * Fetch a collection from a resource
   * @param  {Object} [options.getParams={}]   any getParams to use when fetching the collection
   * @param  {Boolean} [force=false]           whether to respect the cache when fetching
   * @return {Promise}                         Promise that resolves on fetch with the collection
   */
  fetchCollection({ getParams = {}, force = false } = {}) {
    return this.getCollection(getParams).fetch(force);
  }

  /**
   * Do a bulk save of a collection, only works for specific resources
   * @param  {Object[]}  options.data          An array of objects representing the models to be
   * saved.
   * @param  {Object} [options.getParams]      any getParams to use when caching the collection
   * @return {Promise}                         Promise that resolves on save with array of models
   */
  saveCollection({ data = [], getParams = {} } = {}) {
    return this.getCollection(getParams).save(data);
  }

  /**
   * Do a bulk delete of a collection, only works for specific resources, and must use getParams
   * @param  {Object} getParams getParams that more narrowly specify the collection to be deleted.
   * @return {Promise}          Promise that resolves on deletion
   */
  deleteCollection(getParams = {}) {
    return this.getCollection(getParams).delete();
  }

  /**
   * Fetch from a custom detail endpoint on a resource, that returns a single JSON object
   * (as opposed to an array of objects).
   * Mostly used as a convenience method for defining additional endpoint fetch methods on a
   * resource object.
   * @param  {string} detailName The name given to the detail endpoint
   * @param  {string} id         The id of the model for which this is a detail
   * @param  {Object} getParams  Any getParams needed while fetching
   * @return {Promise}           Promise that resolves on fetch with a single object
   */
  fetchDetailModel(detailName, id, getParams = {}) {
    if (!id) {
      throw TypeError('An id must be specified');
    }
    if (!detailName) {
      throw TypeError('A detailName must be specified');
    }
    return this.getModel(id, getParams, detailName).fetch();
  }

  /**
   * Fetch from a custom detail endpoint on a resource, that returns an array of JSON objects
   * (as opposed to a single object).
   * Mostly used as a convenience method for defining additional endpoint fetch methods on a
   * resource object.
   * @param  {string} detailName The name given to the detail endpoint
   * @param  {string} id         The id of the model for which this is a detail
   * @param  {Object} getParams  Any getParams needed while fetching
   * @return {Promise}           Promise that resolves on fetch with an array of objects
   */
  fetchDetailCollection(detailName, id, getParams = {}, force = false) {
    if (!id) {
      throw TypeError('An id must be specified');
    }
    if (!detailName) {
      throw TypeError('A detailName must be specified');
    }
    return this.getCollection(getParams, detailName, id).fetch(force);
  }

  /**
   * Fetch from a custom list endpoint on a resource, that returns an array of JSON objects.
   * Mostly used as a convenience method for defining additional endpoint fethc methods
   * on a resource object.
   * @param  {string} listName   The name given to the list endpoint
   * @param  {Object} getParams  Any getParams needed while fetching
   * @return {Promise}           Promise that resolves on fetch with an array of objects
   */
  fetchListCollection(listName, getParams = {}) {
    if (!listName) {
      throw TypeError('A listName must be specified');
    }
    return this.getCollection(getParams, listName).fetch();
  }

  /**
   * This method is a convenience method for access to a resource endpoint unmediated by the
   * model/collection framework that facilitates caching. This only currently supports list
   * endpoints.
   * @param  {string} method   A valid HTTP method name, in all caps.
   * @param  {string} listName The name given to the list endpoint
   * @param  {Object} args     The getParams or data to be passed to the endpoint,
   * depending on method
   * @return {Promise}         Promise that resolves with the request
   */
  accessEndpoint(method, listName, args = {}, multipart = false) {
    if (!listName) {
      throw TypeError('A listName must be specified');
    }
    let data, params;
    if (method.toLowerCase() === 'get') {
      params = args;
    } else {
      data = args;
    }
    return this.client({
      url: this.getUrlFunction(listName)(),
      method,
      data,
      params,
      multipart,
    });
  }

  /**
   * Call a GET on a custom list endpoint
   * @param  {string} listName The name given to the list endpoint
   * @param  {Object} args     The getParams to be passed to the endpoint
   * @return {Promise}         Promise that resolves with the request
   */
  getListEndpoint(listName, params = {}) {
    return this.accessEndpoint('get', listName, params);
  }

  /**
   * Call a POST on a custom list endpoint
   * @param  {string} listName The name given to the list endpoint
   * @param  {Object} args     The body of the request
   * @return {Promise}         Promise that resolves with the request
   */
  postListEndpoint(listName, params = {}) {
    return this.accessEndpoint('post', listName, params);
  }

  /**
   * Call a POST on a custom list endpoint and use
   * 'multipart/form-data' as Mimetype instead of 'application/json'.
   *
   * @param  {string} listName The name given to the list endpoint
   * @param  {Object} args     The body of the request
   * @return {Promise}         Promise that resolves with the request
   */
  postListEndpointMultipart(listName, params = {}) {
    return this.accessEndpoint('post', listName, params, true);
  }

  /**
   * Reset the cache for this Resource.
   */
  clearCache() {
    this.models = {};
    this.collections = {};
  }

  unCacheModel(id, getParams = {}, endpointName) {
    const cacheKey = this.__cacheKey({ [this.idKey]: id }, getParams);
    if (this.__modelCache(endpointName)[cacheKey]) {
      this.__modelCache(endpointName)[cacheKey].synced = false;
    }
  }

  unCacheCollection(getParams = {}, endpointName) {
    const cacheKey = this.__cacheKey(getParams);
    if (this.__collectionCache(endpointName)[cacheKey]) {
      this.__collectionCache(endpointName)[cacheKey].synced = false;
    }
  }

  removeModel(model, endpointName) {
    const cacheKey = this.__cacheKey({ [this.idKey]: model.id }, model.getParams);
    delete this.__modelCache(endpointName)[cacheKey];
  }

  removeCollection(collection, endpointName) {
    const cacheKey = this.__cacheKey(collection.getParams);
    delete this.__collectionCache(endpointName)[cacheKey];
  }

  get urls() {
    return urls;
  }

  getUrlFunction(endpoint) {
    return this.urls[`${this.name}_${endpoint}`];
  }

  get modelUrl() {
    // Leveraging Django REST Framework generated URL patterns.
    return this.getUrlFunction('detail');
  }

  get collectionUrl() {
    // Leveraging Django REST Framework generated URL patterns.
    return this.getUrlFunction('list');
  }

  client(options) {
    const client = require('./core-app/client').default;
    // Add in content cache parameter if relevant
    if (this.useContentCacheKey && !options.data) {
      options.params = options.params || {};
      options.params['contentCacheKey'] = contentCacheKey;
      options.cacheBust = false;
    }
    return client(options);
  }

  logError(err) {
    const store = require('kolibri.coreVue.vuex.store').default;
    /* eslint-disable no-console */
    console.groupCollapsed(
      `%cRequest error: ${err.response.statusText}, ${
        err.response.status
      } for ${err.config.method.toUpperCase()} to ${err.config.url} - open for more info`,
      'color: red'
    );
    console.log(`Error occured for ${this.name} resource on page ${window.location.href}`);
    if (store.state.route) {
      console.group('Vue Router');
      console.log(`fullPath: ${store.state.route.fullPath}`);
      console.log(`Route name: ${store.state.route.name}`);
      if (Object.keys(store.state.route.params).length) {
        console.group('Vue router params');
        for (let [k, v] of Object.entries(store.state.route.params)) {
          console.log(`${k}: ${v}`);
        }
        console.groupEnd();
      }
      console.groupEnd();
    }
    if (Object.keys(err.config.params).length) {
      console.group('Query parameters');
      for (let [k, v] of Object.entries(err.config.params)) {
        console.log(`${k}: ${v}`);
      }
      console.groupEnd();
    }
    if (err.config.data) {
      try {
        const data = JSON.parse(err.config.data);
        if (Object.keys(data).length) {
          console.group('Data');
          for (let [k, v] of Object.entries(data)) {
            console.log(`${k}: ${v}`);
          }
          console.groupEnd();
        }
      } catch (e) {} // eslint-disable-line no-empty
    }
    if (Object.keys(err.config.headers).length) {
      console.group('Headers');
      for (let [k, v] of Object.entries(err.config.headers)) {
        console.log(`${k}: ${v}`);
      }
      console.groupEnd();
    }
    console.trace('Traceback for request');
    console.groupEnd();
    /* eslint-enable */
  }
}
