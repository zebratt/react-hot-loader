import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import hoistNonReactStatic from 'hoist-non-react-statics';

import { getComponentDisplayName } from './internal/reactUtils';
import configuration from './configuration';
import AppContainer from './AppContainer.dev';
import reactHotLoader from './reactHotLoader';
import { isOpened as isModuleOpened, hotModule, getLastModuleOpened } from './global/modules';
import logger from './logger';
import { clearExceptions, logException } from './errorReporter';
import { createQueue } from './utils/runQueue';
import { enterHotUpdate, getHotGeneration } from './global/generation';

/* eslint-disable camelcase, no-undef */
const requireIndirect = typeof __webpack_require__ !== 'undefined' ? __webpack_require__ : require;
/* eslint-enable */

const chargeFailbackTimer = id =>
  setTimeout(() => {
    const error = `hot update failed for module "${id}". Last file processed: "${getLastModuleOpened()}".`;
    logger.error(error);
    logException({
      toString: () => error,
    });
    // 100 ms more "code" tolerant that 0, and would catch error in any case
  }, 100);

const clearFailbackTimer = timerId => clearTimeout(timerId);

const createHoc = (SourceComponent, TargetComponent) => {
  hoistNonReactStatic(TargetComponent, SourceComponent);
  TargetComponent.displayName = `HotExported${getComponentDisplayName(SourceComponent)}`;
  return TargetComponent;
};

const runInRequireQueue = createQueue();
const runInRenderQueue = createQueue(cb => {
  if (ReactDOM.unstable_batchedUpdates) {
    ReactDOM.unstable_batchedUpdates(cb);
  } else {
    cb();
  }
});

const makeHotExport = (sourceModule, moduleId) => {
  const updateInstances = possibleError => {
    if (possibleError && possibleError instanceof Error) {
      console.error(possibleError);
      return;
    }
    // module: { instances: [Array[1]], updateTimeout: 0 }, 此时instances就会包含一个ExportedComponent
    const module = hotModule(moduleId);

    const deepUpdate = () => {
      // force flush all updates
      runInRenderQueue(() => {
        enterHotUpdate();
        const gen = getHotGeneration();
        // 这里调用组件的forceUpdate方法
        module.instances.forEach(inst => inst.forceUpdate());

        if (configuration.trackTailUpdates) {
          let runLimit = 0;
          const checkTailUpdates = () => {
            setTimeout(() => {
              if (getHotGeneration() !== gen) {
                // we know that some components were updated, but not tracking which ones
                // even if their updates might be incorporated automatically (like lazy)
                // we dont know which one should be tracked, and which updates are important
                logger.warn(
                  'React-Hot-Loader: some components were updated out-of-bound. Updating your app to reconcile the changes.',
                );
                deepUpdate();
              } else if (++runLimit < 5) {
                checkTailUpdates();
              }
            }, 16);
          };

          checkTailUpdates();
        }
      });
    };

    // require all modules
    runInRequireQueue(() => {
      try {
        // webpack will require everything by this time
        // but let's double check...
        requireIndirect(moduleId);
      } catch (e) {
        console.error('React-Hot-Loader: error detected while loading', moduleId);
        console.error(e);
      }
    }).then(deepUpdate);
  };

  if (sourceModule.hot) {
    // Mark as self-accepted for Webpack (callback is an Error Handler)
    // Update instances for Parcel (callback is an Accept Handler)
    // 这里只有当异常发生时才会被调用
    sourceModule.hot.accept(updateInstances);

    // Webpack way
    if (sourceModule.hot.addStatusHandler) {
      if (sourceModule.hot.status() === 'idle') {
        sourceModule.hot.addStatusHandler(status => {
          // 这里status的状态会有：check => prepare => ready => dispose => apply => idle
          if (status === 'apply') {
            clearExceptions();
            updateInstances();
          }
        });
      }
    }
  } else {
    logger.warn('React-hot-loader: Hot Module Replacement is not enabled');
  }
};

/**
 * children: ['./node_modules/webpack/buildin/harmony-module.js', '../../root.js']
 * exports: {__esModule: true}
 * i: './src/components/App.js'
 * l: false
 * parents: ['./src/index.js']
 */
const hot = sourceModule => {
  if (!sourceModule) {
    // this is fatal
    throw new Error('React-hot-loader: `hot` was called without any argument provided');
  }
  const moduleId = sourceModule.id || sourceModule.i || sourceModule.filename;
  if (!moduleId) {
    console.error('`module` provided', sourceModule);
    throw new Error('React-hot-loader: `hot` could not find the `name` of the the `module` you have provided');
  }

  // module: { instances: [], updateTimeout: 0 }
  const module = hotModule(moduleId);

  // 为sourceModule添加module.hot监听， 当我们的classComponent发生变化后，sourceModule也就是App.js
  makeHotExport(sourceModule, moduleId);

  clearExceptions();

  // 注册一个更新失败的函数
  const failbackTimer = chargeFailbackTimer(moduleId);
  let firstHotRegistered = false;

  // TODO: Ensure that all exports from this file are react components.

  // 本例中这个WrappedComponent就是我们在 ExportedApp = hot(App) 中传入的 App 组件
  return (WrappedComponent, props) => {
    // 这里把失败回调注销
    clearFailbackTimer(failbackTimer);
    // register proxy for wrapped component
    // only one hot per file would use this registration
    if (!firstHotRegistered) {
      firstHotRegistered = true;

      // 这里就是核心操作，为我们传入的组件注册proxy
      reactHotLoader.register(WrappedComponent, getComponentDisplayName(WrappedComponent), `RHL${moduleId}`);
    }

    // 创建一个hoc，非react static的变量提升，设置targetComponent的displayName
    return createHoc(
      WrappedComponent,
      class ExportedComponent extends Component {
        componentDidMount() {
          // 这里的module其实就是App.js，appjs的module.instance里面，持有当前ExportedComponent的实例
          // 所以在页面挂载以后，当前高阶组件实例会被保存
          module.instances.push(this);
        }

        componentWillUnmount() {
          if (isModuleOpened(sourceModule)) {
            const componentName = getComponentDisplayName(WrappedComponent);
            logger.error(
              `React-hot-loader: Detected AppContainer unmount on module '${moduleId}' update.\n` +
                `Did you use "hot(${componentName})" and "ReactDOM.render()" in the same file?\n` +
                `"hot(${componentName})" shall only be used as export.\n` +
                `Please refer to "Getting Started" (https://github.com/gaearon/react-hot-loader/).`,
            );
          }
          module.instances = module.instances.filter(a => a !== this);
        }

        // 这里使用AppContainer包裹，可以捕获到所有的error，并且指定自定义的ErrorBoundary
        render() {
          return (
            <AppContainer {...props}>
              <WrappedComponent {...this.props} />
            </AppContainer>
          );
        }
      },
    );
  };
};

export default hot;
