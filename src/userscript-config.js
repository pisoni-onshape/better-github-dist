/**
 * Settings UI Dialog Library
 * Dynamically creates a modal settings dialog based on JSON configuration
 * with persistence storage and validation support.
 * Author: Piyush Soni
 */

class UserScriptConfig {
    constructor(config, callbacks = {}) {
        this.currentDialog = null;
        this.config = config;
        this.callbacks = callbacks;
        this.validationState = new Map();
        this.values = new Map();
        this.groupStates = new Map();
        this.isInitialized = false;
        this.configId = config.configId;
        this.setValueIntoStorage = null;
        this.getValueFromStorage = null;

        // Define SVG icons to remove external dependency
        this.collapsedIconSVG = `
            <svg xmlns="http://www.w3.org/2000/svg" class="usc-icon-downward-svg" viewBox="0 0 20 20">
            <g>
                <polygon points="12 17.586 4.707 10.293 3.293 11.707 12 20.414 20.707 11.707 19.293 10.293 12 17.586"/>
                <polygon points="20.707 5.707 19.293 4.293 12 11.586 4.707 4.293 3.293 5.707 12 14.414 20.707 5.707"/>
            </g>
            </svg>
        `;
        this.expandedIconSVG = `
            <svg xmlns="http://www.w3.org/2000/svg" class="usc-icon-upward-svg" viewBox="0 0 20 20">
            <g>
                <polygon points="12 6.414 19.293 13.707 20.707 12.293 12 3.586 3.293 12.293 4.707 13.707 12 6.414"/>
                <polygon points="3.293 18.293 4.707 19.707 12 12.414 19.293 19.707 20.707 18.293 12 9.586 3.293 18.293"/>
            </g>
            </svg>
        `;
    }

    setupStorageFunctions() {
        if (typeof GM_setValue === 'function' && typeof GM_getValue === 'function') {
            console.debug('Using GM_setValue and GM_getValue for UserScriptConfig settings');
            // Use TamperMonkey's official API if available.
            this.setValueIntoStorage = GM_setValue;
            this.getValueFromStorage = GM_getValue;
        } else {
            console.debug('Using localStorage for UserScriptConfig settings');
            this.setValueIntoStorage = (key, value) => { localStorage.setItem(key, value); };
            this.getValueFromStorage = (key, defaultValue) => {
                const storedValue = localStorage.getItem(key);
                if (storedValue === null || storedValue === undefined) {
                    return defaultValue;
                }

                // Convert 'boolean' string values back to boolean
                if (storedValue === "true" || storedValue === "false") {
                    return storedValue === "true";
                }

                // For all other types the storedValue is fine.
                return storedValue;
            };
        }
    }

    /**
     * Initializes the settings manager with configuration and callbacks
     * @param {string} configId - Unique identifier for this settings instance (used for storage namespacing)
     * @param {Object} config - JSON configuration object
     * @param {Object} callbacks - Optional callback functions {onDialogOpened, onDialogClosed, onSettingsSaved, onSettingChanged}
     */
    init() {
        this.isInitialized = true;

        this.setupStorageFunctions();

        this.setupValidationState();

        // Read from storage and save into the object.
        this.readFromStore();
        if (this.callbacks.onSettingsLoaded && typeof this.callbacks.onSettingsLoaded === 'function') {
            this.callbacks.onSettingsLoaded();
        }
    }

    /**
     * Generates the namespaced storage key
     * @param {string} settingId - The setting ID
     * @returns {string} Namespaced key
     */
    getStorageKey(settingId) {
        return `${this.configId}.${settingId}`;
    }

    hasValidGroups() {
        return this.config.groups && Array.isArray(this.config.groups);
    }

    shouldGroupBeExpanded(group) {
        let shouldBeExpanded = true; // default
        // If the group mentions a `collapsedIf` setting, that takes precedence.
        if (group.collapsedIf) {
            // Format- `collapsedIf: { otherElementId: '<id>', value: <value> }`
            const otherFieldValue = this.getFieldValue(group.collapsedIf.otherElementId);
            shouldBeExpanded = otherFieldValue !== group.collapsedIf.value;
        } else {
            // If it's not a conditional collapse, fetch the remembered setting, if any
            const storageKey = this.getStorageKey(`groupState.${group.id}`);
            const defaultExpanded = (group.expanded === undefined || group.expanded === null) ? true : group.expanded;
            shouldBeExpanded = this.getValueFromStorage(storageKey, defaultExpanded);
        }

        return shouldBeExpanded;
    }

    /**
     * Reads values from storage and caches them into the
     * in memory config object
     */
    readFromStore() {
        if (!this.isInitialized || !this.config.settings) {
            console.warn('Settings not initialized. Call init() first.');
            return this;
        }

        this.config.settings.forEach(setting => {
            try {
                const storageKey = this.getStorageKey(setting.id);
                const value = this.getValueFromStorage(storageKey, setting.defaultValue);
                this.values.set(setting.id, value);
            } catch (error) {
                console.error(`Error reading from storage for ${setting.id}:`, error);
                this.values.set(setting.id, setting.defaultValue);
            }
        });

        // Read group states from storage
        this.readGroupStatesToConfig();

        return this;
    }

    readGroupStatesToConfig() {
        if (this.hasValidGroups()) {
            this.config.groups.forEach(group => {
                try {
                    this.groupStates.set(group.id, this.shouldGroupBeExpanded(group));
                } catch (error) {
                    console.error(`Error reading group state from storage for ${group.id}:`, error);
                    this.groupStates.set(group.id, true);
                }
            });
        }
    }

    /**
     * Writes memory object values to storage
     */
    writeToStorage() {
        if (!this.isInitialized) {
            console.warn('Settings not initialized. Call init() first.');
            return this;
        }

        this.values.forEach((value, id) => {
            try {
                const storageKey = this.getStorageKey(id);
                this.setValueIntoStorage(storageKey, value);
            } catch (error) {
                console.error(`Error writing to storage for ${id}:`, error);
            }
        });

        // Write group states to storage
        this.groupStates.forEach((state, id) => {
            try {
                const storageKey = this.getStorageKey(`groupState.${id}`);
                this.setValueIntoStorage(storageKey, state);
            } catch (error) {
                console.error(`Error writing group state to storage for ${id}:`, error);
            }
        });

        return this;
    }

    /**
     * Resets all values in the Config object to their defaults
     */
    resetToDefaults() {
        if (!this.isInitialized || !this.config.settings) {
            console.warn('Settings not initialized. Call init() first.');
            return this;
        }

        this.config.settings.forEach(setting => {
            this.values.set(setting.id, setting.defaultValue);
        });

        // Reset group states to their default in config
        this.readGroupStatesToConfig();

        return this;
    }

    /**
     * Updates a specific setting value in the cache
     * @param {string} id - Setting ID
     * @param {any} value - New value
     */
    setFieldValue(id, value) {
        if (!this.isInitialized) {
            console.warn('Settings not initialized. Call init() first.');
            return this;
        }

        this.values.set(id, value);
        return this;
    }

    /**
     * Gets a field value by ID
     * @param {string} id - Setting ID
     * @returns {any} The field value
     */
    getFieldValue(id) {
        return this.values.get(id);
    }

    /**
     * Gets all field values as an object
     * @returns {Object} All field values
     */
    getAllFieldValues() {
        const values = {};
        this.values.forEach((value, id) => {
            values[id] = value;
        });
        return values;
    }

    /**
     * Creates and displays the settings dialog using field values
     */
    openSettingsDialog() {
        if (!this.isInitialized) {
            console.warn('Settings not initialized. Call init() first.');
            return null;
        }

        // Remove any existing dialog
        if (this.currentDialog) {
            this.currentDialog.remove();
        }

        // Create dialog structure
        this.currentDialog = this.createDialogStructure(this.config);

        // Add to DOM
        document.body.appendChild(this.currentDialog);

        // Populate with field values
        this.updateSettingsToDialog();

        // Set up conditional logic
        this.setupConditionalLogic();

        // Set up keyboard event handlers
        this.setupKeyboardHandlers();

        // Set up validation
        this.setupValidation();

        // Execute onDialogOpened callback
        if (this.callbacks.onDialogOpened && typeof this.callbacks.onDialogOpened === 'function') {
            this.callbacks.onDialogOpened();
        }

        return this.currentDialog;
    }

    /**
     * Updates field values from the dialog inputs (doesn't write to storage)
     */
    updateSettingsFromDialog() {
        if (!this.currentDialog || !this.config.settings) {
            console.warn('No dialog open or settings not initialized.');
            return this;
        }

        this.config.settings.forEach(setting => {
            const value = this.getInputValue(setting);
            this.values.set(setting.id, value);
        });

        return this;
    }

    /**
     * Updates dialog inputs from field values
     */
    updateSettingsToDialog() {
        if (!this.currentDialog || !this.config.settings) {
            console.warn('No dialog open or settings not initialized.');
            return this;
        }

        this.config.settings.forEach(setting => {
            const fieldValue = this.values.get(setting.id);
            if (fieldValue !== undefined) {
                this.setInputValue(setting, fieldValue);
            }
        });

        // Update group collapse/expand state in dialog
        this.setDialogGroupStatesFromValues();

        return this;
    }

    setDialogGroupStatesFromValues() {
        this.groupStates.forEach((isExpanded, groupId) => {
            this.setDialogGroupState(groupId, isExpanded);
        });
    }

    setDialogGroupState(groupId, isExpanded) {
        const groupContent = this.currentDialog.querySelector(`.usc-settings-group[data-group-id="${groupId}"] .usc-settings-group-content`);
        const iconDownward = this.currentDialog.querySelector(`.usc-settings-group[data-group-id="${groupId}"] .usc-settings-group-header .usc-settings-group-toggle .icon-downward`);
        const iconUpward = this.currentDialog.querySelector(`.usc-settings-group[data-group-id="${groupId}"] .usc-settings-group-header .usc-settings-group-toggle .icon-upward`);
        if (groupContent && iconDownward && iconUpward) {
            if (isExpanded) {
                groupContent.classList.add('expanded');
                iconUpward.style.display = 'block';
                iconDownward.style.display = 'none';
            } else {
                groupContent.classList.remove('expanded');
                iconUpward.style.display = 'none';
                iconDownward.style.display = 'block';
            }
        }
    }

    /**
     * Creates the main dialog structure
     */
    createDialogStructure(config) {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'usc-settings-dialog-overlay';

        // Create main dialog container
        const dialog = document.createElement('div');
        dialog.className = config.dialogCSSClass || 'usc-settings-dialog';

        // Create header if specified
        if (config.headerText) {
            const header = document.createElement('h2');
            header.className = config.headerCSSClass || 'usc-dialog-header';
            header.textContent = config.headerText;
            dialog.appendChild(header);
        }

        // --- Grouping Logic ---
        const groupedSettings = new Map(); // Map groupId to an array of settings
        const groupOrder = []; // Stores the order of groups and ungrouped settings

        // Initialize groupOrder and groupedSettings
        if (config.settings && Array.isArray(config.settings)) {
            const processedGroupIds = new Set();
            config.settings.forEach(setting => {
                if (setting.groupId) {
                    if (!groupedSettings.has(setting.groupId)) {
                        groupedSettings.set(setting.groupId, []);
                        // Add group to order only on its first appearance
                        if (!processedGroupIds.has(setting.groupId)) {
                            groupOrder.push({ type: 'group', id: setting.groupId });
                            processedGroupIds.add(setting.groupId);
                        }
                    }
                    groupedSettings.get(setting.groupId).push(setting);
                } else {
                    groupOrder.push({ type: 'setting', setting: setting });
                }
            });
        }

        // Render settings based on groupOrder
        groupOrder.forEach(item => {
            if (item.type === 'setting') {
                // Render ungrouped setting directly
                const table = document.createElement('table');
                table.className = 'usc-settings-table';
                const row = this.createSettingRow(item.setting);
                table.appendChild(row);
                dialog.appendChild(table);
            } else if (item.type === 'group') {
                // Render group section
                const groupId = item.id;
                const groupConfig = config.groups ? config.groups.find(g => g.id === groupId) : null;
                if (groupConfig) {
                    const groupSection = this.createGroupSection(groupConfig, groupedSettings.get(groupId));
                    dialog.appendChild(groupSection);
                } else {
                    // If group config is missing, just render settings without a group header
                    const table = document.createElement('table');
                    table.className = 'usc-settings-table';
                    groupedSettings.get(groupId).forEach(setting => {
                        const row = this.createSettingRow(setting);
                        table.appendChild(row);
                    });
                    dialog.appendChild(table);
                }
            }
        });
        // --- End Grouping Logic ---

        // Create footer
        const footer = document.createElement('div');
        footer.className = config.footerCSSClass || 'usc-dialog-footer';

        // Add footer text if specified
        if (config.footerText) {
            const footerText = document.createElement('span');
            footerText.textContent = config.footerText;
            footer.appendChild(footerText);
        }

        // Create buttons
        const saveButton = document.createElement('button');
        saveButton.className = config.saveButtonCSSClass || 'usc-save-button';
        saveButton.textContent = config.saveButtonText || 'Save';
        saveButton.addEventListener('click', () => this.handleSave());

        const cancelButton = document.createElement('button');
        cancelButton.className = config.cancelButtonCSSClass || 'usc-cancel-button';
        cancelButton.textContent = config.cancelButtonText || 'Cancel';
        cancelButton.addEventListener('click', () => this.handleCancel());

        footer.appendChild(saveButton);
        footer.appendChild(cancelButton);
        dialog.appendChild(footer);

        overlay.appendChild(dialog);

        return overlay;
    }

    /**
     * Creates a group section with a header and collapsible content.
     * @param {Object} groupConfig - The configuration for the group (id, name, expanded).
     * @param {Array} settingsInGroup - An array of setting objects belonging to this group.
     * @returns {HTMLElement} The group section element.
     */
    createGroupSection(groupConfig, settingsInGroup) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'usc-settings-group';
        groupDiv.setAttribute('data-group-id', groupConfig.id);

        const headerDiv = document.createElement('div');
        headerDiv.className = 'usc-settings-group-header';
        headerDiv.addEventListener('click', () => this.toggleGroup(groupConfig.id));

        const title = document.createElement('h3');
        title.textContent = groupConfig.name;
        headerDiv.appendChild(title);

        const toggleIconSpan = document.createElement('span');
        toggleIconSpan.className = 'usc-settings-group-toggle';

        // Create a div just to fetch a rendered SVG
        const collapsedIconDiv = document.createElement('div');
        collapsedIconDiv.className = 'icon-downward';
        collapsedIconDiv.innerHTML = this.collapsedIconSVG;
        collapsedIconDiv.style.display = 'block'; // Initially show the collapsed icon
        toggleIconSpan.appendChild(collapsedIconDiv);

        const expandedIconDiv = document.createElement('div');
        expandedIconDiv.className = 'icon-upward';
        expandedIconDiv.innerHTML = this.expandedIconSVG;
        expandedIconDiv.style.display = 'none'; // Initially hide the expanded icon
        toggleIconSpan.appendChild(expandedIconDiv);

        headerDiv.appendChild(toggleIconSpan);

        groupDiv.appendChild(headerDiv);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'usc-settings-group-content';

        const table = document.createElement('table');
        table.className = 'usc-settings-table';

        settingsInGroup.forEach(setting => {
            const row = this.createSettingRow(setting);
            table.appendChild(row);
        });

        contentDiv.appendChild(table);
        groupDiv.appendChild(contentDiv);

        return groupDiv;
    }

    /**
     * Toggles the expanded/collapsed state of a group.
     * @param {string} groupId - The ID of the group to toggle.
     */
    toggleGroup(groupId) {
        const groupContent = this.currentDialog.querySelector(`.usc-settings-group[data-group-id="${groupId}"] .usc-settings-group-content`);
        const isExpanded = groupContent.classList.contains('expanded');
        const newExpandedState = !isExpanded;
        this.groupStates.set(groupId, newExpandedState);

        // Update storage immediately for group states
        try {
            const storageKey = this.getStorageKey(`groupState.${groupId}`);
            this.setValueIntoStorage(storageKey, newExpandedState);
        } catch (error) {
            console.error(`Error writing group state to storage for ${groupId}:`, error);
        }

        // Update the UI
        this.setDialogGroupStatesFromValues();
    }

    /**
     * Creates a single setting row
     */
    createSettingRow(setting) {
        const row = document.createElement('tr');
        row.className = 'usc-setting-row';
        if (setting.tooltip) {
            row.title = setting.tooltip;
        }

        // Create label cell
        const labelCell = document.createElement('td');
        labelCell.className = setting.labelCSSClass || 'usc-setting-label';
        const label = document.createElement('label');
        label.textContent = setting.labelText;
        label.setAttribute('for', setting.id);
        labelCell.appendChild(label);

        // Create input cell
        const inputCell = document.createElement('td');
        inputCell.className = 'usc-setting-input-cell';

        // Create input element based on type
        const inputElement = this.createInputElement(setting);
        if (inputElement) { // Ensure inputElement is not null
            inputCell.appendChild(inputElement);
        }

        // Add error message container for validation
        if (setting.validationRegex) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'usc-validation-error';
            errorDiv.id = `${setting.id}-error`;
            errorDiv.style.display = 'none';
            errorDiv.textContent = setting.errorMessage || 'Invalid input';
            inputCell.appendChild(errorDiv);
        }

        row.appendChild(labelCell);
        row.appendChild(inputCell);

        return row;
    }

    /**
     * Creates the appropriate input element based on setting type
     */
    createInputElement(setting) {
        const type = setting.type || 'textbox';
        const inputClass = setting.inputCSSClass || 'usc-setting-input';

        switch (type) {
            case 'textbox':
                const textInput = document.createElement('input');
                textInput.type = 'text';
                textInput.id = setting.id;
                textInput.className = inputClass;
                if (setting.placeholder) {
                    textInput.placeholder = setting.placeholder;
                }
                textInput.addEventListener('input', () => this.handleInputChange(setting));
                return textInput;
            case 'password':
                const passwordInput = document.createElement('input');
                passwordInput.type = 'password';
                passwordInput.id = setting.id;
                passwordInput.className = inputClass;
                passwordInput.addEventListener('input', () => this.handleInputChange(setting));
                return passwordInput;
            case 'checkbox':
                const checkboxInput = document.createElement('input');
                checkboxInput.type = 'checkbox';
                checkboxInput.id = setting.id;
                checkboxInput.className = inputClass;
                checkboxInput.addEventListener('change', () => this.handleInputChange(setting));
                return checkboxInput;
            case 'radio':
                const radioContainer = document.createElement('div');
                radioContainer.className = 'usc-radio-group';

                if (setting.options && Array.isArray(setting.options)) {
                    setting.options.forEach(option => {
                        const radioWrapper = document.createElement('div');
                        radioWrapper.className = 'usc-radio-option';

                        const radioInput = document.createElement('input');
                        radioInput.type = 'radio';
                        radioInput.id = `${setting.id}-${option.value}`;
                        radioInput.name = setting.groupName || setting.id;
                        radioInput.value = option.value;
                        radioInput.className = inputClass;
                        radioInput.addEventListener('change', () => this.handleInputChange(setting));

                        const radioLabel = document.createElement('label');
                        radioLabel.setAttribute('for', `${setting.id}-${option.value}`);
                        radioLabel.textContent = option.text;

                        radioWrapper.appendChild(radioInput);
                        radioWrapper.appendChild(radioLabel);
                        radioContainer.appendChild(radioWrapper);
                    });
                }

                return radioContainer;
            case 'dropdown':
                const selectInput = document.createElement('select');
                selectInput.id = setting.id;
                selectInput.className = inputClass;
                selectInput.addEventListener('change', () => this.handleInputChange(setting));

                if (setting.options && Array.isArray(setting.options)) {
                    setting.options.forEach(option => {
                        const optionElement = document.createElement('option');
                        optionElement.value = option.value;
                        optionElement.textContent = option.text;
                        selectInput.appendChild(optionElement);
                    });
                }

                return selectInput;
            default:
                console.warn('Unrecognized type: ' + setting.type + ', cannot create input element');
                return null;
        }
    }

    /**
     * Sets the value of an input element
     */
    setInputValue(setting, value) {
        const type = setting.type || 'textbox';

        switch (type) {
            case 'textbox':
            case 'password':
                const textInput = document.getElementById(setting.id);
                if (textInput) {
                    textInput.value = value;
                }
                break;

            case 'checkbox':
                const checkboxInput = document.getElementById(setting.id);
                if (checkboxInput) checkboxInput.checked = value === 'true' || value === true;
                break;

            case 'radio':
                const radioInputs = document.querySelectorAll(`input[name="${setting.groupName || setting.id}"]`);
                radioInputs.forEach(radio => {
                    radio.checked = radio.value === value;
                });
                break;

            case 'dropdown':
                const selectInput = document.getElementById(setting.id);
                if (selectInput) selectInput.value = value || '';
                break;
        }
    }

    /**
     * Gets the current value of an input element
     */
    getInputValue(setting) {
        const type = setting.type || 'textbox';

        switch (type) {
            case 'textbox':
            case 'password':
                const textInput = document.getElementById(setting.id);
                return textInput ? textInput.value : '';

            case 'checkbox':
                const checkboxInput = document.getElementById(setting.id);
                return checkboxInput ? checkboxInput.checked : false;

            case 'radio':
                const radioInputs = document.querySelectorAll(`input[name="${setting.groupName || setting.id}"]`);
                for (const radio of radioInputs) {
                    if (radio.checked) return radio.value;
                }
                return '';

            case 'dropdown':
                const selectInput = document.getElementById(setting.id);
                return selectInput ? selectInput.value : '';

            default:
                return '';
        }
    }

    /**
     * Sets up keyboard event handlers
     */
    setupKeyboardHandlers() {
        this.keyboardHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.handleCancel();
            }
        };

        document.addEventListener('keydown', this.keyboardHandler);
    }

    /**
     * Sets up conditional logic for enabledIf
     */
    setupConditionalLogic() {
        if (!this.config.settings) return;

        this.config.settings.forEach(setting => {
            if (setting.enabledIf) {
                this.updateConditionalStateForSetting(setting);
            }
        });

        // See if a group needs to expand or collapse
        if (!this.hasValidGroups()) return;
        this.config.groups.forEach(group => {
            if (group.collapsedIf) {
                // Format- `collapsedIf: { otherElementId: '<id>', value: <value> }`
                const otherFieldValue = this.getFieldValue(group.collapsedIf.otherElementId);
                this.setDialogGroupState(group.id, otherFieldValue !== group.collapsedIf.value);
            }
        });
    }

    /**
     * Updates the enabled/disabled state based on conditional logic
     */
    updateConditionalStateForSetting(setting) {
        if (!setting.enabledIf) return;

        const dependentSetting = this.config.settings.find(s => s.id === setting.enabledIf.otherElementId);
        if (!dependentSetting) return;

        const dependentValue = this.getInputValue(dependentSetting);
        const shouldEnable = dependentValue === setting.enabledIf.value;

        const inputElement = this.getInputElementById(setting.id);
        if (inputElement) {
            inputElement.disabled = !shouldEnable;
            if (!shouldEnable) {
                // If disabling, reset to default value
                this.setInputValue(setting, setting.defaultValue);
            }
            this.validateInput(setting);
        }
    }

    /**
     * Gets the input element by ID (handles radio groups)
     */
    getInputElementById(id) {
        const element = document.getElementById(id);
        if (element) return element;

        // For radio groups, find the first radio button's parent (the usc-radio-group div)
        const radioInputs = document.querySelectorAll(`input[id^="${id}-"]`);
        if (radioInputs.length > 0) {
            // Return the container of the radio group
            return radioInputs[0].closest('.usc-radio-group');
        }
        return null;
    }

    /**
     * Sets up validation state for all settings
     */
    setupValidationState() {
        if (!this.config.settings) return;

        this.config.settings.forEach(setting => {
            this.validationState.set(setting.id, true); // Start as valid
        });
    }

    /**
     * Sets up validation for input elements
     */
    setupValidation() {
        if (!this.config.settings) return;

        this.config.settings.forEach(setting => {
            if (setting.validationRegex && (setting.type === 'textbox' || setting.type === 'password')) {
                this.validateInput(setting);
            }
        });

        this.updateSaveButtonState();
    }

    /**
     * Validates an input element
     */
    validateInput(setting) {
        if (!setting.validationRegex) return true;
        const inputElement = document.getElementById(setting.id);
        const value = this.getInputValue(setting);
        const regex = new RegExp(setting.validationRegex);

        const isValid = regex.test(value) || inputElement.disabled /* if it's disabled, we don't need to test it */;

        this.validationState.set(setting.id, isValid);

        const errorElement = document.getElementById(`${setting.id}-error`);

        if (inputElement) {
            if (isValid) {
                inputElement.classList.remove('usc-invalid-input');
            } else {
                inputElement.classList.add('usc-invalid-input');
            }
        }

        if (errorElement) {
            errorElement.style.display = isValid ? 'none' : 'block';
        }

        this.updateSaveButtonState();
        return isValid;
    }

    /**
     * Updates the save button enabled/disabled state
     */
    updateSaveButtonState() {
        const saveButton = this.currentDialog?.querySelector('.usc-save-button');
        if (!saveButton) return;

        const allValid = Array.from(this.validationState.values()).every(valid => valid);
        saveButton.disabled = !allValid;
    }

    /**
     * Handles input change events
     */
    handleInputChange(setting) {
        // Validate input if needed
        if (setting.validationRegex && (setting.type === 'textbox' || setting.type === 'password')) {
            this.validateInput(setting);
        }

        // Update conditional logic for all settings
        this.config.settings.forEach(s => {
            if (s.enabledIf && s.enabledIf.otherElementId === setting.id) {
                this.updateConditionalStateForSetting(s);
            }
        });

        // See if a group needs to expand or collapse
        if (this.hasValidGroups()) {
            this.config.groups.forEach(group => {
                if (group.collapsedIf && group.collapsedIf.otherElementId === setting.id) {
                    // Format- `collapsedIf: { otherElementId: '<id>', value: <value> }`
                    this.setDialogGroupState(group.id, this.getInputValue(setting) !== group.collapsedIf.value);
                }
            });
        }

        // Execute onSettingChanged callback
        if (this.callbacks.onSettingChanged && typeof this.callbacks.onSettingChanged === 'function') {
            this.callbacks.onSettingChanged(setting.id, this.getInputValue(setting));
        }
    }

    /**
     * Handles save button click
     */
    handleSave() {
        // First update the in-memory config
        // object from the dialog, and then write
        // to the storage.
        this.updateSettingsFromDialog();
        this.writeToStorage();

        // Execute onSettingsSaved callback
        if (this.callbacks.onSettingsSaved && typeof this.callbacks.onSettingsSaved === 'function') {
            this.callbacks.onSettingsSaved();
        }

        this.closeDialog();
    }

    /**
     * Handles cancel button click
     */
    handleCancel() {
        this.closeDialog();
    }

    /**
     * Closes the dialog
     */
    closeDialog() {
        // Remove keyboard event handler
        if (this.keyboardHandler) {
            document.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }

        if (this.currentDialog) {
            this.currentDialog.remove();
            this.currentDialog = null;
        }

        // Execute onDialogClosed callback
        if (this.callbacks.onDialogClosed && typeof this.callbacks.onDialogClosed === 'function') {
            this.callbacks.onDialogClosed();
        }
    }

    /**
     * Checks if dialog is currently open
     */
    isDialogOpen() {
        return this.currentDialog !== null;
    }

    /**
     * Checks if the settings manager is initialized
     */
    isReady() {
        return this.isInitialized;
    }
}

window.UserScriptConfig = UserScriptConfig;
