/**
 * BetterDesk Console - Visual Tutorial System
 * Spotlight-based guided tour with i18n support.
 * 
 * Usage:
 *   Tutorial.start('console'); // Start console panel tutorial
 *   Tutorial.start('desktop'); // Start desktop mode tutorial
 *   Tutorial.skip();           // Skip/close tutorial
 */

(function() {
    'use strict';

    // ============ Constants ============

    const STORAGE_SEEN = 'betterdesk_tutorial_seen';
    const STORAGE_DISABLED = 'betterdesk_tutorial_disabled';
    
    // ============ State ============

    let _overlay = null;
    let _spotlight = null;
    let _tooltip = null;
    let _steps = [];
    let _currentStep = 0;
    let _isActive = false;
    let _onComplete = null;

    // ============ i18n Helper ============

    function t(key, fallback) {
        if (typeof window._ === 'function') {
            var result = window._(key);
            return result !== key ? result : fallback;
        }
        // Manual translation lookup
        if (window.BetterDesk && window.BetterDesk.translations) {
            var keys = key.split('.');
            var val = window.BetterDesk.translations;
            for (var i = 0; i < keys.length; i++) {
                if (val && typeof val === 'object' && keys[i] in val) {
                    val = val[keys[i]];
                } else {
                    return fallback;
                }
            }
            return val || fallback;
        }
        return fallback;
    }

    // ============ Tutorial Definitions ============

    function getConsoleTutorialSteps() {
        return [
            {
                selector: '.sidebar',
                title: t('tutorial.console.sidebar_title', 'Navigation Sidebar'),
                text: t('tutorial.console.sidebar_text', 'Use the sidebar to navigate between different sections of the console. Click on icons to switch pages.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.navbar .search-box',
                title: t('tutorial.console.search_title', 'Quick Search'),
                text: t('tutorial.console.search_text', 'Search for devices, settings, or actions quickly. Press Ctrl+K for keyboard shortcut.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '#desktop-toggle-btn',
                title: t('tutorial.console.desktop_btn_title', 'Desktop Mode'),
                text: t('tutorial.console.desktop_btn_text', 'Switch to desktop mode for a Windows-like experience with floating windows and widgets. Best on large screens.'),
                position: 'left',
                highlight: true
            },
            {
                selector: '.content-wrapper',
                title: t('tutorial.console.content_title', 'Main Content Area'),
                text: t('tutorial.console.content_text', 'This is where all your data and actions are displayed. Each page shows relevant information and controls.'),
                position: 'center',
                highlight: false
            },
            {
                selector: null,
                title: t('tutorial.console.complete_title', 'You\'re Ready!'),
                text: t('tutorial.console.complete_text', 'You can access this tutorial anytime from Settings → Help. Enjoy using BetterDesk Console!'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    function getDesktopTutorialSteps() {
        return [
            {
                selector: '.widget-topnav',
                title: t('tutorial.desktop.topnav_title', 'Top Navigation Bar'),
                text: t('tutorial.desktop.topnav_text', 'Access all modules quickly from here. Click tabs to open apps in floating windows.'),
                position: 'bottom',
                highlight: true
            },
            {
                selector: '.widget-sidebar',
                title: t('tutorial.desktop.sidebar_title', 'Quick Actions'),
                text: t('tutorial.desktop.sidebar_text', 'Add widgets, change wallpaper, access settings and additional modules from the sidebar.'),
                position: 'right',
                highlight: true
            },
            {
                selector: '.widget-canvas',
                title: t('tutorial.desktop.canvas_title', 'Widget Dashboard'),
                text: t('tutorial.desktop.canvas_text', 'Your customizable dashboard. Drag widgets to reposition, resize corners to change size. Click + to add new widgets.'),
                position: 'center',
                highlight: false
            },
            {
                selector: '.desktop-taskbar',
                title: t('tutorial.desktop.taskbar_title', 'Taskbar'),
                text: t('tutorial.desktop.taskbar_text', 'Minimized windows appear here. Use Start menu to launch apps, wallpaper picker, or return to console mode.'),
                position: 'top',
                highlight: true
            },
            {
                selector: null,
                title: t('tutorial.desktop.complete_title', 'Desktop Mode Ready!'),
                text: t('tutorial.desktop.complete_text', 'Try clicking tabs to open apps as floating windows. You can run multiple apps side-by-side!'),
                position: 'center',
                highlight: false,
                final: true
            }
        ];
    }

    // ============ DOM Creation ============

    function createOverlay() {
        if (_overlay) return;
        
        // Main overlay
        _overlay = document.createElement('div');
        _overlay.className = 'tutorial-overlay';
        _overlay.id = 'tutorial-overlay';
        
        // Spotlight cut-out element
        _spotlight = document.createElement('div');
        _spotlight.className = 'tutorial-spotlight';
        _overlay.appendChild(_spotlight);
        
        // Tooltip container
        _tooltip = document.createElement('div');
        _tooltip.className = 'tutorial-tooltip';
        _tooltip.innerHTML = 
            '<div class="tutorial-tooltip-header">' +
                '<span class="tutorial-title"></span>' +
                '<button class="tutorial-close" title="' + t('tutorial.close', 'Close') + '">' +
                    '<span class="material-icons">close</span>' +
                '</button>' +
            '</div>' +
            '<div class="tutorial-tooltip-body"></div>' +
            '<div class="tutorial-tooltip-footer">' +
                '<span class="tutorial-progress"></span>' +
                '<div class="tutorial-actions">' +
                    '<button class="tutorial-btn tutorial-skip">' + t('tutorial.skip', 'Skip') + '</button>' +
                    '<button class="tutorial-btn tutorial-prev">' + t('tutorial.prev', 'Previous') + '</button>' +
                    '<button class="tutorial-btn tutorial-btn-primary tutorial-next">' + t('tutorial.next', 'Next') + '</button>' +
                '</div>' +
            '</div>';
        _overlay.appendChild(_tooltip);
        
        document.body.appendChild(_overlay);
        
        // Event listeners
        _tooltip.querySelector('.tutorial-close').addEventListener('click', skip);
        _tooltip.querySelector('.tutorial-skip').addEventListener('click', skip);
        _tooltip.querySelector('.tutorial-prev').addEventListener('click', prevStep);
        _tooltip.querySelector('.tutorial-next').addEventListener('click', nextStep);
        
        // Close on overlay click (outside tooltip)
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) {
                skip();
            }
        });
        
        // Keyboard navigation
        document.addEventListener('keydown', handleKeyDown);
    }

    function removeOverlay() {
        document.removeEventListener('keydown', handleKeyDown);
        if (_overlay) {
            _overlay.remove();
            _overlay = null;
            _spotlight = null;
            _tooltip = null;
        }
    }

    // ============ Step Navigation ============

    function showStep(index) {
        if (!_steps.length || index < 0 || index >= _steps.length) return;
        
        _currentStep = index;
        var step = _steps[index];
        
        // Update tooltip content
        _tooltip.querySelector('.tutorial-title').textContent = step.title || '';
        _tooltip.querySelector('.tutorial-tooltip-body').textContent = step.text || '';
        _tooltip.querySelector('.tutorial-progress').textContent = 
            t('tutorial.step', 'Step') + ' ' + (index + 1) + ' / ' + _steps.length;
        
        // Update button visibility
        var prevBtn = _tooltip.querySelector('.tutorial-prev');
        var nextBtn = _tooltip.querySelector('.tutorial-next');
        var skipBtn = _tooltip.querySelector('.tutorial-skip');
        
        prevBtn.style.display = index > 0 ? '' : 'none';
        nextBtn.textContent = step.final ? t('tutorial.finish', 'Finish') : t('tutorial.next', 'Next');
        skipBtn.style.display = step.final ? 'none' : '';
        
        // Position spotlight and tooltip
        positionElements(step);
    }

    function positionElements(step) {
        var target = step.selector ? document.querySelector(step.selector) : null;
        
        if (target && step.highlight) {
            // Get target position
            var rect = target.getBoundingClientRect();
            var padding = 8;
            
            // Position spotlight
            _spotlight.style.display = 'block';
            _spotlight.style.left = (rect.left - padding) + 'px';
            _spotlight.style.top = (rect.top - padding) + 'px';
            _spotlight.style.width = (rect.width + padding * 2) + 'px';
            _spotlight.style.height = (rect.height + padding * 2) + 'px';
            
            // Position tooltip based on step.position
            positionTooltip(rect, step.position);
        } else {
            // No target or no highlight - center tooltip
            _spotlight.style.display = 'none';
            _tooltip.style.left = '50%';
            _tooltip.style.top = '50%';
            _tooltip.style.transform = 'translate(-50%, -50%)';
        }
    }

    function positionTooltip(targetRect, position) {
        var tooltipRect = _tooltip.getBoundingClientRect();
        var gap = 16;
        var left, top;
        
        switch (position) {
            case 'top':
                left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
                top = targetRect.top - tooltipRect.height - gap;
                break;
            case 'bottom':
                left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
                top = targetRect.bottom + gap;
                break;
            case 'left':
                left = targetRect.left - tooltipRect.width - gap;
                top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
                break;
            case 'right':
                left = targetRect.right + gap;
                top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
                break;
            default: // center
                left = window.innerWidth / 2 - tooltipRect.width / 2;
                top = window.innerHeight / 2 - tooltipRect.height / 2;
        }
        
        // Keep tooltip in viewport
        left = Math.max(16, Math.min(left, window.innerWidth - tooltipRect.width - 16));
        top = Math.max(16, Math.min(top, window.innerHeight - tooltipRect.height - 16));
        
        _tooltip.style.left = left + 'px';
        _tooltip.style.top = top + 'px';
        _tooltip.style.transform = 'none';
    }

    function nextStep() {
        if (_currentStep < _steps.length - 1) {
            showStep(_currentStep + 1);
        } else {
            complete();
        }
    }

    function prevStep() {
        if (_currentStep > 0) {
            showStep(_currentStep - 1);
        }
    }

    function handleKeyDown(e) {
        if (!_isActive) return;
        
        if (e.key === 'Escape') {
            skip();
        } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
            nextStep();
        } else if (e.key === 'ArrowLeft') {
            prevStep();
        }
    }

    // ============ Public API ============

    function start(type, callback) {
        if (_isActive) return;
        
        // Get tutorial steps based on type
        if (type === 'desktop') {
            _steps = getDesktopTutorialSteps();
        } else {
            _steps = getConsoleTutorialSteps();
        }
        
        if (!_steps.length) return;
        
        _isActive = true;
        _currentStep = 0;
        _onComplete = callback;
        
        createOverlay();
        
        // Animate in
        requestAnimationFrame(function() {
            _overlay.classList.add('active');
            showStep(0);
        });
    }

    function skip() {
        if (!_isActive) return;
        
        _isActive = false;
        _overlay.classList.remove('active');
        
        setTimeout(function() {
            removeOverlay();
            _steps = [];
            _currentStep = 0;
        }, 300);
    }

    function complete() {
        // Mark as seen
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        seen[_steps === getDesktopTutorialSteps() ? 'desktop' : 'console'] = true;
        localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));
        
        _isActive = false;
        _overlay.classList.remove('active');
        
        setTimeout(function() {
            removeOverlay();
            if (typeof _onComplete === 'function') {
                _onComplete();
            }
            _steps = [];
            _currentStep = 0;
            _onComplete = null;
        }, 300);
    }

    function hasSeenTutorial(type) {
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        return seen[type || 'console'] === true;
    }

    function resetTutorial(type) {
        var seen = JSON.parse(localStorage.getItem(STORAGE_SEEN) || '{}');
        if (type) {
            delete seen[type];
        } else {
            seen = {};
        }
        localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));
    }

    function setDisabled(disabled) {
        localStorage.setItem(STORAGE_DISABLED, disabled ? 'true' : 'false');
    }

    function isDisabled() {
        return localStorage.getItem(STORAGE_DISABLED) === 'true';
    }

    // Auto-start on first visit (if not disabled)
    function autoStart(type) {
        if (isDisabled()) return;
        if (hasSeenTutorial(type)) return;
        
        // Small delay to let the page settle
        setTimeout(function() {
            start(type);
        }, 1000);
    }

    // ============ Export ============

    window.Tutorial = {
        start: start,
        skip: skip,
        hasSeenTutorial: hasSeenTutorial,
        resetTutorial: resetTutorial,
        setDisabled: setDisabled,
        isDisabled: isDisabled,
        autoStart: autoStart
    };

})();
